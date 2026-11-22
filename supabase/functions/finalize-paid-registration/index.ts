import { createClient } from "npm:@supabase/supabase-js@2";
const cors={ "Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS" };
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});}
async function sha256(v:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,"0")).join("");}
const planProfiles:Record<string,string>={client_monthly:"client",professional_monthly:"professional",salon_monthly:"salon",company_monthly:"company"};
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return json({error:"method_not_allowed"},405);
 try{
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key)return json({error:"server_not_configured"},503);
  const body=await req.json().catch(()=>({}));
  const token=typeof body.token==="string"?body.token:"";
  const userId=typeof body.user_id==="string"?body.user_id:"";
  if(!/^[a-f0-9]{64}$/.test(token)||!/^[0-9a-f-]{36}$/i.test(userId))return json({error:"invalid_request"},400);
  const admin=createClient(url,key,{auth:{persistSession:false}});
  const {data:checkout,error:checkoutError}=await admin.from("wallue_pending_checkouts")
   .select("id,plan_code,email,external_reference,provider_subscription_id,provider_order_id,checkout_status,amount_cents,currency,registered_user_id,registration_completed_at,first_authorized_payment_id,first_provider_payment_id,first_payment_status,first_payment_status_detail,first_payment_created_at,first_payment_updated_at,payment_method")
   .eq("registration_token_hash",await sha256(token)).maybeSingle();
  if(checkoutError||!checkout)return json({error:"checkout_not_found"},404);
  if(checkout.checkout_status!=="authorized")return json({error:"payment_not_authorized"},409);
  const {data:userResult,error:userError}=await admin.auth.admin.getUserById(userId);
  const user=userResult?.user;
  if(userError||!user)return json({error:"auth_user_not_found"},404);
  if((user.email??"").toLowerCase()!==checkout.email.toLowerCase())return json({error:"email_mismatch"},403);
  const expectedProfile=planProfiles[checkout.plan_code];
  if(!expectedProfile||user.user_metadata?.profile_type!==expectedProfile||user.user_metadata?.plan_code!==checkout.plan_code)return json({error:"profile_plan_mismatch"},409);
  const metadata=user.user_metadata??{};
  if(metadata.consent_to_data_processing!==true)return json({error:"consent_required"},409);
  const fullName=String(metadata.full_name??"").trim();
  const city=String(metadata.city??"").trim();
  const whatsapp=String(metadata.whatsapp??"").replace(/\\D/g,"");
  if(fullName.length<2||fullName.length>120||city.length<2||city.length>100||whatsapp.length<10||whatsapp.length>15)
    return json({error:"profile_details_incomplete"},409);
  const {error:profileError}=await admin.from("wallue_profiles").upsert({
    user_id:userId,email:checkout.email,full_name:fullName,profile_type:expectedProfile,
    company_name:metadata.company_name?String(metadata.company_name):null,
    city,neighborhood:metadata.neighborhood?String(metadata.neighborhood):null,
    whatsapp,service_interest:metadata.service_interest?String(metadata.service_interest):null,
    instagram_url:metadata.instagram_url?String(metadata.instagram_url):null,
    client_intent:expectedProfile==="client"&&["beauty_services","job_opportunities"].includes(metadata.client_intent)?metadata.client_intent:"beauty_services",
    has_cleaning_team:expectedProfile==="client"&&metadata.client_intent==="job_opportunities"&&metadata.has_cleaning_team===true,
    has_mei_or_cnpj:expectedProfile==="client"&&metadata.client_intent==="job_opportunities"&&metadata.has_mei_or_cnpj===true,
    company_discovery_consent:expectedProfile==="client"&&metadata.client_intent==="job_opportunities"&&metadata.company_discovery_consent===true,
    company_discovery_consent_at:expectedProfile==="client"&&metadata.client_intent==="job_opportunities"&&metadata.company_discovery_consent===true&&metadata.company_discovery_consent_at?String(metadata.company_discovery_consent_at):null,
    candidate_job_title:expectedProfile==="client"&&metadata.client_intent==="job_opportunities"&&metadata.candidate_job_title?String(metadata.candidate_job_title).slice(0,120):null,
    candidate_experience:expectedProfile==="client"&&metadata.client_intent==="job_opportunities"&&metadata.candidate_experience?String(metadata.candidate_experience).slice(0,60):null,
    candidate_skills:expectedProfile==="client"&&metadata.client_intent==="job_opportunities"&&metadata.candidate_skills?String(metadata.candidate_skills).slice(0,500):null,
    candidate_availability:expectedProfile==="client"&&metadata.client_intent==="job_opportunities"&&metadata.candidate_availability?String(metadata.candidate_availability).slice(0,60):null,
    consent_to_data_processing:true,updated_at:new Date().toISOString()
  },{onConflict:"user_id"});
  if(profileError){console.error("paid registration profile save failed",profileError.message);return json({error:"profile_save_failed"},500);}
  if(checkout.registered_user_id&&checkout.registered_user_id!==userId)return json({error:"checkout_already_linked"},409);
  const isOneTime=!!checkout.provider_order_id;
  const providerId=isOneTime?checkout.provider_order_id:checkout.provider_subscription_id;
  if(!providerId)return json({error:"provider_reference_missing"},409);
  const {data:existing,error:existingError}=await admin.from("wallue_subscriptions")
   .select("id,user_id,plan_code,provider_subscription_id,provider_order_id,external_reference")
   .eq("external_reference",checkout.external_reference).maybeSingle();
  if(existingError)return json({error:"subscription_lookup_failed"},500);
  if(existing&&existing.user_id!==userId)return json({error:"checkout_already_linked"},409);
  if(existing&&existing.plan_code!==checkout.plan_code)return json({error:"plan_mismatch"},409);
  if(existing){
   const existingProviderId=isOneTime?existing.provider_order_id:existing.provider_subscription_id;
   if(existingProviderId!==providerId)return json({error:"provider_reference_mismatch"},409);
  }else{
   const paidAt=checkout.authorized_at?new Date(checkout.authorized_at).getTime():Date.now();
   const expiresAt=isOneTime?new Date(paidAt+30*24*60*60*1000).toISOString():null;
   const {error:insertError}=await admin.from("wallue_subscriptions").insert({
    user_id:userId,plan_code:checkout.plan_code,provider:"mercadopago",
    provider_subscription_id:isOneTime?null:providerId,
    provider_order_id:isOneTime?providerId:null,
    external_reference:checkout.external_reference,amount_cents:checkout.amount_cents,
    currency:checkout.currency,status:"authorized",
    provider_status:isOneTime?"processed":"authorized",
    checkout_url:null,access_expires_at:expiresAt,payment_method:checkout.payment_method??null,
    last_provider_event_at:new Date().toISOString()
   });
   if(insertError){console.error("payment access record insert failed",insertError.message);return json({error:"access_record_insert_failed"},500);}
  }
  const {data:sub,error:subError}=await admin.from("wallue_subscriptions")
   .select("id").eq("external_reference",checkout.external_reference).single();
  if(subError||!sub)return json({error:"access_record_lookup_failed"},500);

  // Transfer every payment captured by the Order webhook to the permanent ledger.
  // The provider payment ID is unique, so repeated finalization cannot duplicate entries.
  const {data:stagedPayments,error:stagedError}=await admin.from("wallue_pending_checkout_payments")
   .select("provider_order_id,provider_payment_id,amount_cents,currency,payment_status,payment_status_detail,payment_method,provider_created_at,provider_updated_at")
   .eq("pending_checkout_id",checkout.id).order("created_at",{ascending:true});
  if(stagedError)return json({error:"staged_payment_lookup_failed"},500);

  const paymentsToWrite=(stagedPayments??[]).map((p:Record<string,unknown>)=>({
   subscription_id:sub.id,user_id:userId,provider:"mercadopago",
   authorized_payment_id:`order:${String(p.provider_order_id)}:payment:${String(p.provider_payment_id)}`,
   provider_payment_id:String(p.provider_payment_id),
   amount_cents:Number(p.amount_cents),currency:String(p.currency),
   invoice_status:"confirmed",payment_status:"approved",
   payment_status_detail:p.payment_status_detail==null?"accredited":String(p.payment_status_detail),
   retry_attempt:null,debit_date:null,
   provider_created_at:p.provider_created_at??null,
   provider_updated_at:p.provider_updated_at??null,
   last_synced_at:new Date().toISOString(),updated_at:new Date().toISOString()
  }));

  // Compatibility fallback for older checkouts created before per-payment staging.
  if(paymentsToWrite.length===0&&checkout.first_authorized_payment_id&&checkout.first_payment_status==="approved"){
   paymentsToWrite.push({
    subscription_id:sub.id,user_id:userId,provider:"mercadopago",
    authorized_payment_id:checkout.first_provider_payment_id?`order:${checkout.provider_order_id}:payment:${checkout.first_provider_payment_id}`:String(checkout.first_authorized_payment_id),
    provider_payment_id:checkout.first_provider_payment_id,
    amount_cents:checkout.amount_cents,currency:checkout.currency,
    invoice_status:"confirmed",payment_status:"approved",
    payment_status_detail:checkout.first_payment_status_detail,
    retry_attempt:null,debit_date:null,
    provider_created_at:checkout.first_payment_created_at,
    provider_updated_at:checkout.first_payment_updated_at,
    last_synced_at:new Date().toISOString(),updated_at:new Date().toISOString()
   });
  }
  if(paymentsToWrite.length===0)return json({error:"approved_payment_record_missing"},409);
  const {error:ledgerError}=await admin.from("wallue_subscription_payments")
   .upsert(paymentsToWrite,{onConflict:"authorized_payment_id"});
  if(ledgerError){console.error("payment ledger write failed",ledgerError.message);return json({error:"payment_ledger_write_failed"},500);}
  const {error:updateError}=await admin.from("wallue_pending_checkouts").update({
   registered_user_id:userId,registration_completed_at:checkout.registration_completed_at??new Date().toISOString(),updated_at:new Date().toISOString()
  }).eq("id",checkout.id);
  if(updateError)return json({error:"checkout_finalize_failed"},500);
  return json({ok:true,subscription_linked:true,access_expires_in_days:isOneTime?30:null,email_confirmed:!!user.email_confirmed_at});
 }catch(e){console.error("finalize checkout error",e instanceof Error?e.message:"unknown");return json({error:"internal_error"},500);}
});
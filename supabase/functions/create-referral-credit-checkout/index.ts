import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://conecta.wallue.com.br",
  "https://wallue-site-git-wallue-referral-cred-fdf60c-walluebeautclub2018.vercel.app",
]);
function corsHeaders(origin: string | null) {
  const allowed = origin && allowedOrigins.has(origin) ? origin : "https://conecta.wallue.com.br";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

const PRODUCTS = {
  single_referral: { credits: 1, amountCents: 229, title: "Desbloqueio de contato - 1 crédito" },
  credit_pack_12: { credits: 12, amountCents: 1699, title: "Pacote Wallue - 12 créditos" },
} as const;

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

Deno.serve(async (req: Request) => {
  const respond = (body: unknown, status = 200) => json(body, status, req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req.headers.get("Origin")) });
  if (req.method !== "POST") return respond({ error: "method_not_allowed" }, 405);
  try {
    // Feature flag isolada: nunca reutiliza WALLUE_BILLING_ENABLED.
    if (Deno.env.get("WALLUE_REFERRAL_CREDITS_ENABLED") !== "test") {
      return respond({ error: "referral_credits_not_enabled" }, 503);
    }

    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return respond({ error: "login_required" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const environment = (Deno.env.get("MERCADOPAGO_REFERRAL_ENVIRONMENT") ?? "test").trim().toLowerCase();
    const mpToken = environment === "test"
      ? Deno.env.get("MERCADOPAGO_REFERRAL_TEST_ACCESS_TOKEN")
      : Deno.env.get("MERCADOPAGO_REFERRAL_ACCESS_TOKEN");
    if (!supabaseUrl || !serviceKey || !mpToken) return respond({ error: "server_not_configured" }, 503);
    if (environment !== "test") return respond({ error: "referral_credits_test_environment_only" }, 503);
    if (!mpToken.startsWith("TEST-")) return respond({ error: "test_access_token_required" }, 503);

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const jwt = authorization.slice(7);
    const { data: authData, error: authError } = await admin.auth.getUser(jwt);
    const user = authData?.user;
    if (authError || !user?.id || !user.email || !validEmail(user.email)) return respond({ error: "invalid_session" }, 401);

    const { data: profile, error: profileError } = await admin.from("wallue_profiles")
      .select("profile_type").eq("user_id", user.id).maybeSingle();
    if (profileError || !profile || !["professional", "salon"].includes(profile.profile_type)) {
      return respond({ error: "professional_profile_required" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const kind = body?.purchase_kind as keyof typeof PRODUCTS;
    if (!(kind in PRODUCTS)) return respond({ error: "invalid_product" }, 400);
    const product = PRODUCTS[kind];

    let referralEventId: string | null = null;
    if (kind === "single_referral") {
      referralEventId = typeof body.referral_event_id === "string" ? body.referral_event_id : null;
      if (!referralEventId) return respond({ error: "referral_event_required" }, 400);

      const { data: referral, error: referralError } = await admin.from("referral_events")
        .select("id,professional_user_id,fee_amount_cents,currency,status,client_consent_at,chargeable_at,paid_at")
        .eq("id", referralEventId).maybeSingle();
      if (referralError || !referral) return respond({ error: "referral_not_found" }, 404);
      if (referral.professional_user_id !== user.id) return respond({ error: "referral_not_owned" }, 403);
      if (referral.status !== "chargeable" || !referral.chargeable_at || !referral.client_consent_at || referral.paid_at) {
        return respond({ error: "referral_not_chargeable" }, 409);
      }
      // Eventos históricos a R$0,99 não são convertidos em cobranças de R$2,29.
      if (referral.fee_amount_cents !== 229 || referral.currency !== "BRL") {
        return respond({ error: "referral_uses_historical_price" }, 409);
      }

      const { data: priorDebit, error: debitError } = await admin.from("wallue_referral_credit_ledger")
        .select("id").eq("user_id", user.id).eq("referral_event_id", referralEventId)
        .eq("transaction_type", "referral_debit").maybeSingle();
      if (debitError) return respond({ error: "referral_ledger_check_failed" }, 500);
      if (priorDebit) return respond({ error: "referral_already_unlocked" }, 409);
    }

    const externalReference = crypto.randomUUID();
    const { data: purchase, error: insertError } = await admin.from("wallue_referral_credit_purchases")
      .insert({
        user_id: user.id,
        purchase_kind: kind,
        referral_event_id: referralEventId,
        credits_purchased: product.credits,
        amount_cents: product.amountCents,
        currency: "BRL",
        status: "creating",
        provider_environment: environment,
        external_reference: externalReference,
      })
      .select("id")
      .single();
    if (insertError || !purchase) {
      console.error("Credit purchase initialization failed", insertError?.message);
      return respond({ error: "purchase_initialization_failed" }, 500);
    }

    let payerEmail = user.email.toLowerCase();
    if (environment === "test") {
      payerEmail = (Deno.env.get("MERCADOPAGO_TEST_PAYER_EMAIL") ?? "").trim().toLowerCase();
      if (!validEmail(payerEmail)) {
        await admin.from("wallue_referral_credit_purchases").update({ status: "failed", provider_status: "test_payer_not_configured" }).eq("id", purchase.id);
        return respond({ error: "test_payer_not_configured" }, 503);
      }
    }

    const amount = (product.amountCents / 100).toFixed(2);
    const returnUrl = new URL("https://wallue-site-git-wallue-referral-cred-fdf60c-walluebeautclub2018.vercel.app/");
    returnUrl.searchParams.set("credit_purchase", "pending");
    const payload = {
      type: "online",
      processing_mode: "manual",
      total_amount: amount,
      external_reference: externalReference,
      description: `Wallue Conecta - ${product.title}`,
      payer: { email: payerEmail },
      items: [{ title: `Wallue Conecta - ${product.title}`, quantity: 1, unit_price: amount }],
      config: { online: {
        success_url: returnUrl.toString(),
        pending_url: returnUrl.toString(),
        failure_url: returnUrl.toString(),
        auto_return: "approved",
      }},
    };

    const mpResponse = await fetch("https://api.mercadopago.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mpToken}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": purchase.id,
      },
      body: JSON.stringify(payload),
    });
    const mpData = await mpResponse.json().catch(() => ({}));
    if (!mpResponse.ok || !mpData?.id || !mpData?.checkout_url) {
      await admin.from("wallue_referral_credit_purchases").update({
        status: "failed", provider_status: "order_creation_failed", updated_at: new Date().toISOString(),
      }).eq("id", purchase.id);
      console.error("Mercado Pago credit Order failed", mpResponse.status, mpData?.message ?? "unknown");
      return respond({ error: "mercadopago_order_creation_failed" }, 502);
    }

    const { error: updateError } = await admin.from("wallue_referral_credit_purchases").update({
      provider_order_id: String(mpData.id),
      provider_status: String(mpData.status ?? "created"),
      status: "pending",
      updated_at: new Date().toISOString(),
    }).eq("id", purchase.id);
    if (updateError) return respond({ error: "order_created_but_not_saved_contact_support" }, 500);

    return respond({ checkout_url: mpData.checkout_url, purchase_id: purchase.id });
  } catch (error) {
    console.error("Referral credit checkout error", error instanceof Error ? error.message : "unknown");
    return respond({ error: "internal_error" }, 500);
  }
});

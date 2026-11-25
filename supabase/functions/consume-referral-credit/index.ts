import { createClient } from "npm:@supabase/supabase-js@2";

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  try {
    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return reply({ error: "login_required" }, 401);
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) return reply({ error: "server_not_configured" }, 503);

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: authData, error: authError } = await admin.auth.getUser(authorization.slice(7));
    const user = authData?.user;
    if (authError || !user?.id) return reply({ error: "invalid_session" }, 401);

    const { data: profile, error: profileError } = await admin.from("wallue_profiles")
      .select("profile_type").eq("user_id", user.id).maybeSingle();
    if (profileError || !profile || !["professional", "salon"].includes(profile.profile_type)) {
      return reply({ error: "professional_profile_required" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const referralEventId = typeof body?.referral_event_id === "string" ? body.referral_event_id : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(referralEventId)) {
      return reply({ error: "invalid_referral_event_id" }, 400);
    }

    const { data: consumed, error: consumeError } = await admin.rpc("wallue_consume_referral_credit", {
      p_user_id: user.id,
      p_referral_event_id: referralEventId,
    });
    if (consumeError || !consumed?.length) {
      const code = consumeError?.message ?? "credit_consumption_failed";
      const status = /insufficient_credits/.test(code) ? 409 :
        /already_unlocked/.test(code) ? 409 :
        /not_owned/.test(code) ? 403 :
        /not_found/.test(code) ? 404 : 409;
      return reply({ error: code }, status);
    }

    const clientUserId = consumed[0].client_user_id;
    const { data: client, error: clientError } = await admin.from("wallue_profiles")
      .select("full_name,whatsapp,city,neighborhood").eq("user_id", clientUserId).maybeSingle();
    if (clientError || !client?.whatsapp) {
      console.error("Unlocked contact profile unavailable", clientError?.message ?? "missing_whatsapp");
      return reply({ error: "contact_unlocked_but_contact_details_unavailable", credits_remaining: consumed[0].credits_remaining }, 200);
    }

    return reply({
      unlocked: true,
      credits_remaining: consumed[0].credits_remaining,
      contact: {
        name: client.full_name ?? "Cliente Wallue",
        whatsapp: client.whatsapp,
        city: client.city ?? "",
        neighborhood: client.neighborhood ?? "",
      },
    });
  } catch (error) {
    console.error("Consume referral credit failed", error instanceof Error ? error.message : "unknown");
    return reply({ error: "internal_error" }, 500);
  }
});

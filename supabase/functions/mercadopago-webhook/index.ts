import { createClient } from "npm:@supabase/supabase-js@2";

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function validSignature(req: Request, dataId: string, secret: string): Promise<boolean> {
  const signature = req.headers.get("x-signature");
  const requestId = req.headers.get("x-request-id");
  if (!signature || !requestId || !dataId) return false;
  const parts = new Map<string, string>();
  for (const item of signature.split(",")) {
    const [key, ...rest] = item.trim().split("=");
    if (key && rest.length) parts.set(key, rest.join("=").trim());
  }
  const ts = parts.get("ts");
  const v1 = parts.get("v1");
  if (!ts || !v1 || !/^[a-f0-9]{64}$/i.test(v1)) return false;
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(manifest),
  ));
  const expected = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return safeEqual(expected.toLowerCase(), v1.toLowerCase());
}

function toIso(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  try {
    const secret = Deno.env.get("MERCADOPAGO_WEBHOOK_SECRET");
    const referralTestSecret = Deno.env.get("MERCADOPAGO_REFERRAL_TEST_WEBHOOK_SECRET");
    const referralProductionSecret = Deno.env.get("MERCADOPAGO_REFERRAL_WEBHOOK_SECRET");
    const token = Deno.env.get("MERCADOPAGO_ACCESS_TOKEN");
    const referralProductionToken = Deno.env.get("MERCADOPAGO_REFERRAL_ACCESS_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if ((!secret && !referralTestSecret && !referralProductionSecret) || !token || !supabaseUrl || !serviceKey) {
      console.error("Webhook secrets/configuration missing.");
      return reply(503, { error: "webhook_not_configured" });
    }

    const url = new URL(req.url);
    const dataId = url.searchParams.get("data.id") ?? "";
    const rawBody = await req.text();
    let body: Record<string, unknown> = {};
    try { body = rawBody ? JSON.parse(rawBody) : {}; }
    catch { return reply(400, { error: "invalid_json" }); }

    const bodyData = body.data && typeof body.data === "object"
      ? body.data as Record<string, unknown> : {};
    const resourceId = dataId || String(bodyData.id ?? "");
    const eventType = url.searchParams.get("type") || String(body.type ?? "");
    if (!resourceId) return reply(400, { error: "missing_resource_id" });
    const productionSignatureValid = secret ? await validSignature(req, resourceId, secret) : false;
    const referralTestSignatureValid = referralTestSecret
      ? await validSignature(req, resourceId, referralTestSecret) : false;
    const referralProductionSignatureValid = referralProductionSecret
      ? await validSignature(req, resourceId, referralProductionSecret) : false;
    if (!productionSignatureValid && !referralTestSignatureValid && !referralProductionSignatureValid) {
      return reply(401, { error: "invalid_signature" });
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    const notificationId = body.id == null ? "" : String(body.id);
    if (notificationId) {
      const { error: eventInsertError } = await admin
        .from("wallue_mercadopago_webhook_events")
        .upsert({
          provider_notification_id: notificationId,
          resource_type: eventType || "unknown",
          resource_id: resourceId,
          action: typeof body.action === "string" ? body.action : null,
          processing_status: "received",
          last_error_code: null,
        }, { onConflict: "provider_notification_id", ignoreDuplicates: true });
      if (eventInsertError) {
        console.error("Webhook event log insert failed:", eventInsertError.message);
        return reply(500, { error: "event_log_failed" });
      }
      const { data: priorEvent, error: priorError } = await admin
        .from("wallue_mercadopago_webhook_events")
        .select("processing_status")
        .eq("provider_notification_id", notificationId)
        .maybeSingle();
      if (priorError) return reply(500, { error: "event_log_lookup_failed" });
      if (priorEvent?.processing_status === "processed" ||
          priorEvent?.processing_status === "ignored") {
        return reply(200, { received: true, duplicate: true });
      }
    }

    if (eventType === "order") {
      const { data: knownCreditOrder, error: knownCreditError } = await admin
        .from("wallue_referral_credit_purchases")
        .select("provider_environment")
        .eq("provider_order_id", resourceId)
        .maybeSingle();
      if (knownCreditError) return reply(500, { error: "credit_order_environment_lookup_failed" });
      const referralTestToken = Deno.env.get("MERCADOPAGO_REFERRAL_TEST_ACCESS_TOKEN");
      const preferredToken = knownCreditOrder?.provider_environment === "production" && referralProductionToken
        ? referralProductionToken
        : knownCreditOrder?.provider_environment === "test" && referralTestToken
          ? referralTestToken : token;
      let response = await fetch(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(resourceId)}`, {
        headers: { Authorization: `Bearer ${preferredToken}` },
      });
      // Recovery for orders created before the provider order ID was persisted.
      if (!response.ok && preferredToken !== token) {
        response = await fetch(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(resourceId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      }
      if (!response.ok && preferredToken !== referralProductionToken && referralProductionToken) {
        response = await fetch(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(resourceId)}`, {
          headers: { Authorization: `Bearer ${referralProductionToken}` },
        });
      }
      if (!response.ok && preferredToken !== referralTestToken && referralTestToken) {
        response = await fetch(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(resourceId)}`, {
          headers: { Authorization: `Bearer ${referralTestToken}` },
        });
      }
      if (!response.ok) {
        console.error("Order lookup failed:", response.status);
        return reply(502, { error: "order_lookup_failed" });
      }
      const order = await response.json();
      const externalReference = String(order.external_reference ?? "");

      // Carteira de créditos: fluxo isolado das assinaturas mensais.
      // Só processa referências previamente criadas pela função autenticada de créditos.
      const { data: creditPurchase, error: creditLookupError } = await admin
        .from("wallue_referral_credit_purchases")
        .select("id,amount_cents,currency,status,provider_order_id")
        .eq("external_reference", externalReference)
        .maybeSingle();
      if (creditLookupError) {
        console.error("Referral credit purchase lookup failed:", creditLookupError.message);
        return reply(500, { error: "credit_purchase_lookup_failed" });
      }
      if (creditPurchase) {
        const amount = Number(order.total_amount);
        const paidAmount = Number(order.total_paid_amount ?? 0);
        const currency = String(order.currency_id ?? order.currency ?? "BRL");
        const tx = order.transactions && typeof order.transactions === "object"
          ? order.transactions as Record<string, unknown> : {};
        const payments = Array.isArray(tx.payments)
          ? tx.payments as Array<Record<string, unknown>> : [];
        const approvedPayments = payments.filter((payment) =>
          String(payment.status ?? "") === "processed" &&
          String(payment.status_detail ?? "") === "accredited" &&
          payment.id != null
        );
        const orderId = String(order.id ?? resourceId);
        if (creditPurchase.provider_order_id && creditPurchase.provider_order_id !== orderId) {
          console.error("Referral credit order id mismatch", { orderId });
          return reply(409, { error: "credit_order_id_mismatch" });
        }
        if (!Number.isFinite(amount) || Math.round(amount * 100) !== creditPurchase.amount_cents ||
            !Number.isFinite(paidAmount) || Math.round(paidAmount * 100) > creditPurchase.amount_cents ||
            currency !== creditPurchase.currency) {
          console.error("Referral credit order amount/currency mismatch", { orderId, amount, paidAmount, currency });
          return reply(409, { error: "credit_order_amount_currency_mismatch" });
        }

        const orderProcessed = String(order.status ?? "") === "processed";
        if (orderProcessed && Math.round(paidAmount * 100) === creditPurchase.amount_cents &&
            approvedPayments.length === 1) {
          const individualPaid = Number(approvedPayments[0].amount ?? approvedPayments[0].paid_amount ??
            approvedPayments[0].transaction_amount ?? order.total_paid_amount);
          if (!Number.isFinite(individualPaid) || Math.round(individualPaid * 100) !== creditPurchase.amount_cents) {
            console.error("Referral credit individual payment amount mismatch", { orderId, individualPaid });
            return reply(409, { error: "credit_payment_amount_mismatch" });
          }
          const paymentIds = approvedPayments.map((payment) => String(payment.id));
          const paidAt = toIso(order.last_updated_date) ?? new Date().toISOString();
          const { data: appliedRows, error: applyError } = await admin.rpc(
            "wallue_apply_referral_credit_purchase",
            {
              p_purchase_id: creditPurchase.id,
              p_provider_order_id: orderId,
              p_provider_payment_id: paymentIds[0],
              p_provider_status: String(order.status),
              p_paid_amount_cents: Math.round(paidAmount * 100),
              p_currency: currency,
              p_paid_at: paidAt,
            },
          );
          if (applyError || !appliedRows?.length) {
            console.error("Referral credit settlement failed:", applyError?.message);
            return reply(500, { error: "credit_settlement_failed" });
          }
        } else if (creditPurchase.status === "creating" || creditPurchase.status === "pending") {
          await admin.from("wallue_referral_credit_purchases").update({
            provider_order_id: orderId,
            provider_status: String(order.status ?? "unknown"),
            status: "pending",
            updated_at: new Date().toISOString(),
          }).eq("id", creditPurchase.id);
        }
        // Não deixa esta ordem cair no fluxo de checkout/assinatura mensal.
        if (notificationId) {
          const isSettled = orderProcessed && Math.round(paidAmount * 100) === creditPurchase.amount_cents &&
            approvedPayments.length === 1;
          const { error: doneError } = await admin.from("wallue_mercadopago_webhook_events")
            .update({
              processing_status: isSettled ? "processed" : "received",
              processed_at: isSettled ? new Date().toISOString() : null,
              last_error_code: null
            })
            .eq("provider_notification_id", notificationId);
          if (doneError) return reply(500, { error: "event_completion_failed" });
        }
        return reply(200, { received: true, processed: orderProcessed, credit_purchase: true });
      }

      const { data: pending, error: pendingError } = await admin
        .from("wallue_pending_checkouts")
        .select("id,amount_cents,currency,checkout_status,registered_user_id,plan_code")
        .eq("external_reference", externalReference)
        .maybeSingle();
      if (pendingError) return reply(500, { error: "pending_order_lookup_failed" });
      if (!pending) {
        if (notificationId) await admin.from("wallue_mercadopago_webhook_events")
          .update({ processing_status: "ignored", processed_at: new Date().toISOString() })
          .eq("provider_notification_id", notificationId);
        return reply(200, { received: true, ignored: "unknown_order" });
      }
      const amount = Number(order.total_amount);
      const currency = String(order.currency_id ?? order.currency ?? "BRL");
      if (!Number.isFinite(amount) || Math.round(amount * 100) !== pending.amount_cents || currency !== pending.currency) {
        console.error("Order amount/currency mismatch", { resourceId, amount, currency });
        return reply(409, { error: "order_amount_currency_mismatch" });
      }
      const tx = order.transactions && typeof order.transactions === "object"
        ? order.transactions as Record<string, unknown> : {};
      const payments = Array.isArray(tx.payments) ? tx.payments as Array<Record<string, unknown>> : [];
      const paidAmount = Number(order.total_paid_amount ?? 0);
      const approvedPayments = payments.filter((payment) =>
        String(payment.status ?? "") === "processed" &&
        String(payment.status_detail ?? "") === "accredited" &&
        payment.id != null
      );
      const approved = String(order.status ?? "") === "processed" &&
        Number.isFinite(paidAmount) && Math.round(paidAmount * 100) >= pending.amount_cents &&
        approvedPayments.length > 0;
      const providerStatus = String(order.status ?? "unknown");
      const firstPayment = approvedPayments[0];
      const firstPaymentId = firstPayment?.id == null ? null : String(firstPayment.id);
      const firstPaymentMethod = firstPayment?.payment_method && typeof firstPayment.payment_method === "object"
        ? String((firstPayment.payment_method as Record<string, unknown>).id ?? "") : null;
      const now = new Date().toISOString();

      const { error: updateError } = await admin.from("wallue_pending_checkouts").update({
        provider_order_id: String(order.id ?? resourceId),
        provider_status: providerStatus,
        checkout_status: approved ? "authorized" : pending.checkout_status,
        authorized_at: approved ? (toIso(order.last_updated_date) ?? now) : null,
        first_authorized_payment_id: approved ? String(order.id ?? resourceId) : null,
        first_provider_payment_id: firstPaymentId,
        first_payment_status: approved ? "approved" : providerStatus,
        first_payment_status_detail: approved ? "accredited" : String(order.status_detail ?? ""),
        first_payment_created_at: toIso(order.created_date),
        first_payment_updated_at: toIso(order.last_updated_date),
        payment_method: firstPaymentMethod,
        updated_at: now,
      }).eq("id", pending.id);
      if (updateError) return reply(500, { error: "pending_order_update_failed" });

      // Persist every approved Order payment immediately, including initial signups
      // that have not created their Auth user yet. Unique provider_payment_id makes retries safe.
      if (approved) {
        const orderId = String(order.id ?? resourceId);
        for (const payment of approvedPayments) {
          const paymentId = String(payment.id);
          const paymentAmount = Number(payment.amount ?? payment.paid_amount ??
            payment.transaction_amount ?? (approvedPayments.length === 1 ? order.total_paid_amount : NaN));
          if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
            console.error("Approved order payment has no valid individual amount:", paymentId);
            return reply(422, { error: "approved_payment_amount_missing" });
          }
          const paymentMethod = payment.payment_method && typeof payment.payment_method === "object"
            ? String((payment.payment_method as Record<string, unknown>).id ?? "") : null;
          const { error: stagedError } = await admin.from("wallue_pending_checkout_payments").upsert({
            pending_checkout_id: pending.id,
            provider_order_id: orderId,
            provider_payment_id: paymentId,
            amount_cents: Math.round(paymentAmount * 100),
            currency: pending.currency,
            payment_status: "approved",
            payment_status_detail: String(payment.status_detail ?? "accredited"),
            payment_method: paymentMethod,
            provider_created_at: toIso(order.created_date),
            provider_updated_at: toIso(order.last_updated_date),
            updated_at: now,
          }, { onConflict: "pending_checkout_id,provider_payment_id" });
          if (stagedError) {
            console.error("Pending individual payment staging failed:", stagedError.message);
            return reply(500, { error: "pending_individual_payment_write_failed" });
          }
        }
      }

      // Serialize paid renewals per user in the database. Replayed notifications
      // resolve to the same external_reference and do not add another 30 days.
      if (approved && pending.registered_user_id) {
        const orderId = String(order.id ?? resourceId);
        const paidAt = toIso(order.last_updated_date) ?? now;
        const { data: accessRows, error: accessError } = await admin.rpc(
          "wallue_extend_access_for_paid_order",
          {
            p_user_id: pending.registered_user_id,
            p_plan_code: pending.plan_code,
            p_external_reference: externalReference,
            p_order_id: orderId,
            p_amount_cents: pending.amount_cents,
            p_currency: pending.currency,
            p_payment_method: firstPaymentMethod,
            p_paid_at: paidAt,
          },
        );
        if (accessError || !accessRows?.length) {
          console.error("Atomic renewal extension failed:", accessError?.message);
          return reply(500, { error: "renewal_access_extension_failed" });
        }
        const subscriptionId = accessRows[0].subscription_id;
        for (const payment of approvedPayments) {
          const paymentId = String(payment.id);
          const paymentAmount = Number(payment.amount ?? payment.transaction_amount ??
            (approvedPayments.length === 1 ? order.total_paid_amount : NaN));
          if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
            console.error("Approved order payment has no valid individual amount:", paymentId);
            return reply(422, { error: "approved_payment_amount_missing" });
          }
          const paymentMethod = payment.payment_method && typeof payment.payment_method === "object"
            ? String((payment.payment_method as Record<string, unknown>).id ?? "") : null;
          const { error: ledgerError } = await admin.from("wallue_subscription_payments").upsert({
            subscription_id: subscriptionId,
            user_id: pending.registered_user_id,
            provider: "mercadopago",
            authorized_payment_id: `order:${orderId}:payment:${paymentId}`,
            provider_payment_id: paymentId,
            amount_cents: Math.round(paymentAmount * 100),
            currency: pending.currency,
            invoice_status: "confirmed",
            payment_status: "approved",
            payment_status_detail: String(payment.status_detail ?? "accredited"),
            retry_attempt: null,
            debit_date: null,
            provider_created_at: toIso(order.created_date),
            provider_updated_at: toIso(order.last_updated_date),
            last_synced_at: now,
            updated_at: now,
          }, { onConflict: "authorized_payment_id" });
          if (ledgerError) {
            console.error("Individual payment ledger upsert failed:", ledgerError.message);
            return reply(500, { error: "individual_payment_ledger_write_failed" });
          }
        }
      }
    } else if (eventType === "subscription_preapproval" || eventType === "preapproval") {
      const response = await fetch(
        `https://api.mercadopago.com/preapproval/${encodeURIComponent(resourceId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        console.error("Preapproval lookup failed:", response.status);
        return reply(502, { error: "provider_lookup_failed" });
      }
      const preapproval = await response.json();
      const externalReference = String(preapproval.external_reference ?? "");
      const providerStatus = String(preapproval.status ?? "pending");
      const mappedStatus =
        providerStatus === "authorized" ? "authorized" :
        providerStatus === "paused" ? "paused" :
        providerStatus === "cancelled" ? "cancelled" :
        providerStatus === "rejected" ? "rejected" : "pending";

      // Check pre-registration checkout first. Approval unlocks the registration form,
      // but does not create or activate a member profile.
      if (externalReference) {
        const { data: pendingCheckout, error: pendingLookupError } = await admin
          .from("wallue_pending_checkouts")
          .select("id,email,amount_cents,currency,checkout_status")
          .eq("external_reference", externalReference)
          .maybeSingle();
        if (pendingLookupError) {
          console.error("Pending checkout lookup failed:", pendingLookupError.message);
          return reply(500, { error: "pending_checkout_lookup_failed" });
        }
        if (pendingCheckout) {
          const recurring = preapproval.auto_recurring && typeof preapproval.auto_recurring === "object"
            ? preapproval.auto_recurring as Record<string, unknown> : {};
          const providerAmount = Number(recurring.transaction_amount);
          const providerCurrency = String(recurring.currency_id ?? "BRL");
          // In test mode, payer_email is the dedicated Mercado Pago test buyer,
          // while pendingCheckout.email is the real customer's Wallue account email.
          // They are intentionally different and must never be compared.
          if (providerCurrency !== pendingCheckout.currency ||
              Math.round(providerAmount * 100) !== pendingCheckout.amount_cents) {
            console.error("Preapproval amount/currency mismatch for pending checkout.", {
              resourceId, providerCurrency, providerAmount,
            });
            return reply(409, { error: "pending_checkout_details_mismatch" });
          }
          const pendingStatus =
            providerStatus === "authorized" ? "authorized" :
            providerStatus === "paused" ? "paused" :
            providerStatus === "cancelled" ? "cancelled" :
            providerStatus === "rejected" ? "rejected" : "pending";
          // Subscription authorization alone is not proof that the first charge was approved.
          // Keep the registration locked until an approved authorized-payment notification arrives.
          const nextStatus = pendingCheckout.checkout_status === "authorized" && pendingStatus === "pending"
            ? "authorized" : (pendingStatus === "authorized" ? "pending" : pendingStatus);
          const { error: pendingError } = await admin.from("wallue_pending_checkouts")
            .update({
              provider_subscription_id: String(preapproval.id ?? resourceId),
              provider_status: providerStatus,
              checkout_status: nextStatus,
              authorized_at: nextStatus === "authorized" ? new Date().toISOString() : null,
              updated_at: new Date().toISOString(),
            }).eq("id", pendingCheckout.id);
          if (pendingError) {
            console.error("Pending checkout update failed:", pendingError.message);
            return reply(500, { error: "pending_checkout_update_failed" });
          }
        } else {
          let query = admin.from("wallue_subscriptions")
            .update({
          provider_subscription_id: String(preapproval.id ?? resourceId),
          provider_status: providerStatus,
          status: mappedStatus,
          last_provider_event_at: toIso(preapproval.last_modified) ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      if (externalReference) query = query.eq("external_reference", externalReference);
      else query = query.eq("provider_subscription_id", resourceId);
      const { data, error } = await query.select("id");
      if (error) {
        console.error("Subscription update failed:", error.message);
        return reply(500, { error: "database_update_failed" });
      }
      if (!data?.length) {
        if (notificationId) await admin.from("wallue_mercadopago_webhook_events")
          .update({ processing_status: "ignored", processed_at: new Date().toISOString() })
          .eq("provider_notification_id", notificationId);
        return reply(200, { received: true, ignored: "unknown_subscription" });
      }
          }
        }
    } else if (eventType === "subscription_authorized_payment") {
      const response = await fetch(
        `https://api.mercadopago.com/authorized_payments/${encodeURIComponent(resourceId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        console.error("Authorized payment lookup failed:", response.status);
        return reply(502, { error: "authorized_payment_lookup_failed" });
      }

      const invoice = await response.json();
      const preapprovalId = String(invoice.preapproval_id ?? "");
      const externalReference = String(invoice.external_reference ?? "");
      let pendingRows: Array<Record<string, unknown>> | null = null;
      if (preapprovalId) {
        const { data, error } = await admin.from("wallue_pending_checkouts")
          .select("id,amount_cents,currency,provider_subscription_id,checkout_status")
          .eq("provider_subscription_id", preapprovalId).limit(1);
        if (error) return reply(500, { error: "pending_invoice_lookup_failed" });
        pendingRows = data;
      }
      if ((!pendingRows || !pendingRows.length) && externalReference) {
        const { data, error } = await admin.from("wallue_pending_checkouts")
          .select("id,amount_cents,currency,provider_subscription_id,checkout_status")
          .eq("external_reference", externalReference).limit(1);
        if (error) return reply(500, { error: "pending_invoice_lookup_failed" });
        pendingRows = data;
      }
      const pendingCheckout = pendingRows?.[0];
      if (pendingCheckout) {
        const amount = Number(invoice.transaction_amount);
        const amountCents = Math.round(amount * 100);
        const currency = String(invoice.currency_id ?? "BRL");
        if (!Number.isFinite(amount) || amount <= 0 || currency !== pendingCheckout.currency || amountCents !== pendingCheckout.amount_cents) {
          console.error("Pending checkout invoice amount/currency mismatch.", { resourceId, amountCents, currency });
          return reply(409, { error: "pending_invoice_amount_mismatch" });
        }
        const payment = invoice.payment && typeof invoice.payment === "object"
          ? invoice.payment as Record<string, unknown> : {};
        const paymentStatus = payment.status == null ? String(invoice.status ?? "") : String(payment.status);
        const approved = paymentStatus === "approved";
        const failed = ["rejected","cancelled","refunded","charged_back"].includes(paymentStatus);
        const nextStatus = approved ? "authorized" : failed ? "rejected" : pendingCheckout.checkout_status;
        const paymentId = payment.id == null ? null : String(payment.id);
        const { error: pendingUpdateError } = await admin.from("wallue_pending_checkouts").update({
          checkout_status: nextStatus,
          provider_status: approved ? "authorized" : paymentStatus || "pending",
          authorized_at: approved ? new Date().toISOString() : null,
          first_authorized_payment_id: String(invoice.id ?? resourceId),
          first_provider_payment_id: paymentId,
          first_payment_status: paymentStatus || null,
          first_payment_status_detail: payment.status_detail == null ? null : String(payment.status_detail),
          first_payment_created_at: toIso(invoice.date_created),
          first_payment_updated_at: toIso(invoice.last_modified),
          updated_at: new Date().toISOString(),
        }).eq("id", pendingCheckout.id);
        if (pendingUpdateError) return reply(500, { error: "pending_invoice_update_failed" });
      } else {
      let subQuery = admin.from("wallue_subscriptions")
        .select("id,user_id,amount_cents,currency,provider_subscription_id,external_reference");
      if (preapprovalId) subQuery = subQuery.eq("provider_subscription_id", preapprovalId);
      else if (externalReference) subQuery = subQuery.eq("external_reference", externalReference);
      else return reply(422, { error: "invoice_missing_subscription_reference" });

      const { data: subscription, error: subError } = await subQuery.maybeSingle();
      if (subError) {
        console.error("Invoice subscription lookup failed:", subError.message);
        return reply(500, { error: "subscription_lookup_failed" });
      }
      if (!subscription) return reply(200, { received: true, ignored: "unknown_subscription" });

      const amount = Number(invoice.transaction_amount);
      if (!Number.isFinite(amount) || amount <= 0) return reply(422, { error: "invalid_invoice_amount" });
      const amountCents = Math.round(amount * 100);
      const currency = String(invoice.currency_id ?? "BRL");
      if (currency !== "BRL" || amountCents !== subscription.amount_cents) {
        console.error("Invoice amount/currency mismatch.", {
          subscriptionId: subscription.id, amountCents, currency,
        });
        return reply(409, { error: "invoice_amount_mismatch" });
      }

      const payment = invoice.payment && typeof invoice.payment === "object"
        ? invoice.payment as Record<string, unknown> : {};
      const paymentStatus = payment.status == null ? null : String(payment.status);
      const summarized = String(invoice.summarized ?? "");
      const rawStatus = String(invoice.status ?? "");
      const invoiceStatus =
        paymentStatus === "approved" ? "confirmed" :
        paymentStatus === "rejected" ? "failed" :
        paymentStatus === "cancelled" ? "cancelled" :
        paymentStatus === "refunded" ? "refunded" :
        paymentStatus === "pending" || paymentStatus === "in_process" ? "pending" :
        rawStatus === "scheduled" ? "scheduled" :
        summarized === "pending" ? "pending" : "unknown";

      const paymentId = payment.id == null ? null : String(payment.id);
      const { error: ledgerError } = await admin
        .from("wallue_subscription_payments")
        .upsert({
          subscription_id: subscription.id,
          user_id: subscription.user_id,
          authorized_payment_id: String(invoice.id ?? resourceId),
          provider_payment_id: paymentId,
          amount_cents: amountCents,
          currency,
          invoice_status: invoiceStatus,
          payment_status: paymentStatus,
          payment_status_detail: payment.status_detail == null ? null : String(payment.status_detail),
          retry_attempt: Number.isInteger(Number(invoice.retry_attempt)) ? Number(invoice.retry_attempt) : null,
          debit_date: toIso(invoice.debit_date),
          provider_created_at: toIso(invoice.date_created),
          provider_updated_at: toIso(invoice.last_modified),
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: "authorized_payment_id" });
      if (ledgerError) {
        console.error("Payment ledger upsert failed:", ledgerError.message);
        return reply(500, { error: "payment_ledger_write_failed" });
      }
      }
    } else {
      if (notificationId) await admin.from("wallue_mercadopago_webhook_events")
        .update({ processing_status: "ignored", processed_at: new Date().toISOString() })
        .eq("provider_notification_id", notificationId);
      return reply(200, { received: true, ignored: "event_not_used" });
    }

    if (notificationId) {
      const { error } = await admin.from("wallue_mercadopago_webhook_events")
        .update({
          processing_status: "processed",
          processed_at: new Date().toISOString(),
          last_error_code: null,
        })
        .eq("provider_notification_id", notificationId);
      if (error) {
        console.error("Webhook event completion failed:", error.message);
        return reply(500, { error: "event_completion_failed" });
      }
    }
    return reply(200, { received: true, processed: true });
  } catch (error) {
    console.error("Webhook processing error:", error instanceof Error ? error.message : "unknown");
    return reply(500, { error: "internal_error" });
  }
});
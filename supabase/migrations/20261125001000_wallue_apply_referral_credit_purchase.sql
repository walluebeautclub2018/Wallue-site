-- Confirmação atômica e idempotente dos créditos após validação do Mercado Pago.
begin;

create or replace function public.wallue_apply_referral_credit_purchase(
  p_purchase_id uuid,
  p_provider_order_id text,
  p_provider_payment_id text,
  p_provider_status text,
  p_paid_amount_cents integer,
  p_currency text,
  p_paid_at timestamptz
)
returns table(applied boolean, purchase_status text, balance_delta integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_purchase public.wallue_referral_credit_purchases%rowtype;
begin
  if p_provider_order_id is null or p_provider_payment_id is null
     or p_provider_status <> 'processed'
     or p_currency <> 'BRL' or p_paid_amount_cents <= 0 then
    raise exception 'invalid_provider_payment' using errcode = '22023';
  end if;

  select * into v_purchase
  from public.wallue_referral_credit_purchases
  where id = p_purchase_id
  for update;

  if not found then
    raise exception 'credit_purchase_not_found' using errcode = 'P0002';
  end if;

  if v_purchase.provider_order_id is not null
     and v_purchase.provider_order_id <> p_provider_order_id then
    raise exception 'provider_order_mismatch' using errcode = '23514';
  end if;

  if v_purchase.amount_cents <> p_paid_amount_cents
     or v_purchase.currency <> p_currency then
    raise exception 'purchase_amount_currency_mismatch' using errcode = '23514';
  end if;

  if v_purchase.status = 'approved' then
    return query select false, v_purchase.status, 0;
    return;
  end if;

  if v_purchase.status not in ('creating', 'pending') then
    raise exception 'purchase_not_approvable' using errcode = '23514';
  end if;

  update public.wallue_referral_credit_purchases
  set status = 'approved',
      provider_order_id = p_provider_order_id,
      provider_payment_id = p_provider_payment_id,
      provider_status = p_provider_status,
      paid_at = coalesce(p_paid_at, now()),
      updated_at = now()
  where id = p_purchase_id;

  insert into public.wallue_referral_credit_ledger (
    user_id, purchase_id, transaction_type, credits_delta,
    idempotency_key, description
  ) values (
    v_purchase.user_id, v_purchase.id, 'purchase_credit',
    v_purchase.credits_purchased,
    'purchase:' || v_purchase.id::text,
    case when v_purchase.purchase_kind = 'credit_pack_12'
      then 'Compra de pacote de 12 créditos'
      else 'Compra avulsa para desbloqueio de indicação'
    end
  ) on conflict (idempotency_key) do nothing;

  if not exists (
    select 1 from public.wallue_referral_credit_ledger
    where purchase_id = v_purchase.id
      and user_id = v_purchase.user_id
      and transaction_type = 'purchase_credit'
      and credits_delta = v_purchase.credits_purchased
      and idempotency_key = 'purchase:' || v_purchase.id::text
  ) then
    raise exception 'purchase_credit_ledger_mismatch' using errcode = '23514';
  end if;

  if v_purchase.purchase_kind = 'single_referral' then
    if v_purchase.referral_event_id is null then
      raise exception 'single_referral_missing_event' using errcode = '23514';
    end if;

    update public.referral_events
    set status = 'paid', paid_at = coalesce(p_paid_at, now())
    where id = v_purchase.referral_event_id
      and professional_user_id = v_purchase.user_id
      and status = 'chargeable'
      and fee_amount_cents = 229
      and currency = 'BRL'
      and client_consent_at is not null
      and chargeable_at is not null
      and paid_at is null;

    if not found then
      raise exception 'referral_not_chargeable_at_settlement' using errcode = '23514';
    end if;

    insert into public.wallue_referral_credit_ledger (
      user_id, referral_event_id, transaction_type, credits_delta,
      idempotency_key, description
    ) values (
      v_purchase.user_id, v_purchase.referral_event_id, 'referral_debit', -1,
      'referral:' || v_purchase.referral_event_id::text,
      'Crédito consumido para desbloquear contato'
    ) on conflict (idempotency_key) do nothing;

    if not exists (
      select 1 from public.wallue_referral_credit_ledger
      where user_id = v_purchase.user_id
        and referral_event_id = v_purchase.referral_event_id
        and transaction_type = 'referral_debit'
        and credits_delta = -1
        and idempotency_key = 'referral:' || v_purchase.referral_event_id::text
    ) then
      raise exception 'referral_debit_ledger_mismatch' using errcode = '23514';
    end if;
  end if;

  return query select true, 'approved'::text, v_purchase.credits_purchased;
end;
$$;

revoke all on function public.wallue_apply_referral_credit_purchase(uuid,text,text,text,integer,text,timestamptz) from public, anon, authenticated;
grant execute on function public.wallue_apply_referral_credit_purchase(uuid,text,text,text,integer,text,timestamptz) to service_role;

commit;

-- Índices de suporte às chaves estrangeiras da carteira de créditos.
begin;
create index if not exists wallue_credit_purchases_referral_event_idx
  on public.wallue_referral_credit_purchases (referral_event_id)
  where referral_event_id is not null;
create index if not exists wallue_credit_ledger_referral_event_idx
  on public.wallue_referral_credit_ledger (referral_event_id)
  where referral_event_id is not null;
commit;

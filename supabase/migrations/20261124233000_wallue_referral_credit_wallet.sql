-- Wallue Conecta: carteira independente de créditos para indicações.
-- Esta migração é aditiva: não altera assinaturas, planos mensais ou pagamentos existentes.
-- Aplicar somente após revisão e validação em ambiente de desenvolvimento.

begin;

-- Mantém o valor histórico de R$ 0,99 para registros antigos e permite
-- o novo valor avulso de R$ 2,29 para novas indicações.
alter table public.referral_events
  drop constraint if exists referral_events_fee_amount_cents_check;

alter table public.referral_events
  add constraint referral_events_fee_amount_cents_check
  check (fee_amount_cents in (99, 229));

-- Uma compra representa exclusivamente um produto de créditos, nunca uma assinatura.
create table if not exists public.wallue_referral_credit_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  purchase_kind text not null
    check (purchase_kind in ('single_referral', 'credit_pack_12')),
  referral_event_id uuid references public.referral_events(id) on delete restrict,
  credits_purchased integer not null,
  amount_cents integer not null,
  currency text not null default 'BRL' check (currency = 'BRL'),
  status text not null default 'creating'
    check (status in ('creating', 'pending', 'approved', 'failed', 'cancelled', 'refunded')),
  external_reference text not null unique,
  provider text not null default 'mercadopago' check (provider = 'mercadopago'),
  provider_order_id text unique,
  provider_payment_id text,
  provider_status text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wallue_credit_purchase_product_amount_check check (
    (purchase_kind = 'single_referral'
      and referral_event_id is not null
      and credits_purchased = 1
      and amount_cents = 229)
    or
    (purchase_kind = 'credit_pack_12'
      and referral_event_id is null
      and credits_purchased = 12
      and amount_cents = 1699)
  )
);

-- Evita criar duas cobranças abertas para a mesma indicação/profissional.
create unique index if not exists wallue_credit_one_open_purchase_per_referral
  on public.wallue_referral_credit_purchases (user_id, referral_event_id)
  where referral_event_id is not null
    and status in ('creating', 'pending', 'approved');

create unique index if not exists wallue_credit_provider_payment_unique
  on public.wallue_referral_credit_purchases (provider_payment_id)
  where provider_payment_id is not null;

-- Livro-razão: cada compra gera uma entrada; cada indicação liberada consome
-- exatamente um crédito. O saldo é a soma dos lançamentos, não um campo editável.
create table if not exists public.wallue_referral_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  purchase_id uuid references public.wallue_referral_credit_purchases(id) on delete restrict,
  referral_event_id uuid references public.referral_events(id) on delete restrict,
  transaction_type text not null
    check (transaction_type in ('purchase_credit', 'referral_debit', 'refund_credit', 'admin_adjustment')),
  credits_delta integer not null check (credits_delta <> 0),
  idempotency_key text not null unique,
  description text,
  created_at timestamptz not null default now(),
  constraint wallue_credit_ledger_transaction_shape check (
    (transaction_type = 'purchase_credit' and purchase_id is not null
      and referral_event_id is null and credits_delta > 0)
    or
    (transaction_type = 'referral_debit' and purchase_id is null
      and referral_event_id is not null and credits_delta = -1)
    or
    (transaction_type = 'refund_credit' and referral_event_id is not null
      and credits_delta > 0)
    or
    (transaction_type = 'admin_adjustment')
  )
);

create unique index if not exists wallue_credit_one_purchase_credit_entry
  on public.wallue_referral_credit_ledger (purchase_id)
  where transaction_type = 'purchase_credit';

create unique index if not exists wallue_credit_one_debit_per_referral
  on public.wallue_referral_credit_ledger (user_id, referral_event_id)
  where transaction_type = 'referral_debit';

create index if not exists wallue_credit_ledger_user_created
  on public.wallue_referral_credit_ledger (user_id, created_at desc);

create index if not exists wallue_credit_purchases_user_created
  on public.wallue_referral_credit_purchases (user_id, created_at desc);

alter table public.wallue_referral_credit_purchases enable row level security;
alter table public.wallue_referral_credit_ledger enable row level security;

-- O associado consulta somente seus próprios pedidos e lançamentos.
-- Nenhuma operação financeira é liberada por INSERT/UPDATE direto do navegador.
drop policy if exists "Members read own referral credit purchases"
  on public.wallue_referral_credit_purchases;
create policy "Members read own referral credit purchases"
  on public.wallue_referral_credit_purchases
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Members read own referral credit ledger"
  on public.wallue_referral_credit_ledger;
create policy "Members read own referral credit ledger"
  on public.wallue_referral_credit_ledger
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.wallue_referral_credit_purchases from anon, authenticated;
revoke all on public.wallue_referral_credit_ledger from anon, authenticated;
grant select on public.wallue_referral_credit_purchases to authenticated;
grant select on public.wallue_referral_credit_ledger to authenticated;

commit;

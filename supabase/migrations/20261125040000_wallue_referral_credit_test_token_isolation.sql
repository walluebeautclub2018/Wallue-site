begin;
alter table public.wallue_referral_credit_purchases
  add column if not exists provider_environment text not null default 'test';
alter table public.wallue_referral_credit_purchases
  drop constraint if exists wallue_referral_credit_purchases_provider_environment_check;
alter table public.wallue_referral_credit_purchases
  add constraint wallue_referral_credit_purchases_provider_environment_check
  check (provider_environment in ('test','production'));
commit;

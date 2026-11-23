-- Wallue Conecta: intent and candidate discovery preferences.
-- Additive only: existing profile_type, payment plans and billing records remain unchanged.
alter table public.wallue_profiles
  add column if not exists client_intent text not null default 'beauty_services'
    check (client_intent in ('beauty_services','job_opportunities')),
  add column if not exists has_cleaning_team boolean not null default false,
  add column if not exists has_mei_or_cnpj boolean not null default false,
  add column if not exists company_discovery_consent boolean not null default false,
  add column if not exists company_discovery_consent_at timestamptz,
  add column if not exists candidate_job_title text,
  add column if not exists candidate_experience text,
  add column if not exists candidate_skills text,
  add column if not exists candidate_availability text;

-- Consent is always opt-in. Clear any timestamp when consent is false.
update public.wallue_profiles
set company_discovery_consent_at = null
where company_discovery_consent = false and company_discovery_consent_at is not null;

grant select (client_intent, has_cleaning_team, has_mei_or_cnpj, company_discovery_consent,
  company_discovery_consent_at, candidate_job_title, candidate_experience, candidate_skills,
  candidate_availability) on public.wallue_profiles to authenticated;
grant update (client_intent, has_cleaning_team, has_mei_or_cnpj, company_discovery_consent,
  candidate_job_title, candidate_experience, candidate_skills,
  candidate_availability) on public.wallue_profiles to authenticated;

create index if not exists wallue_profiles_candidate_search_idx
  on public.wallue_profiles (city, candidate_job_title, candidate_experience)
  where profile_type = 'client' and company_discovery_consent = true;

comment on column public.wallue_profiles.company_discovery_consent is
  'Opt-in authorization for the profile to appear in a restricted company talent search; false by default.';

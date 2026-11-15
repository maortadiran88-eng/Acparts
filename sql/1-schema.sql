-- =====================================================================
-- קטלוג חלקי חילוף VRF: מסד נתונים ב-Supabase, כניסה בסיסמה בלבד (בלי Supabase Authentication)
--
-- איך מריצים: Supabase > SQL Editor > New query > הדבק את כל התוכן של הקובץ > Run.
-- בטוח להרצה חוזרת. לא מוחק נתונים קיימים ולא משנה סיסמאות.
-- אחרי זה מריצים את 2-first-users.sql כדי להקים את המשתמשים הראשונים.
--
-- הקובץ משתמש בסכמה פרטית בשם vrf ובפונקציות vrf_*. לכן הוא יכול לשבת באותו פרויקט Supabase
-- של אתרים אחרים שלך (למשל אתר המפוצלים) בלי להתנגש בהם.
--
-- איך האבטחה עובדת:
--  * כל הטבלאות בסכמה vrf, שה-API של Supabase לא חושף בכלל. המפתח הציבורי (publishable) לבדו לא נותן גישה לכלום.
--  * הגישה היחידה היא פונקציות vrf_* שבודקות אסימון (token) שמתקבל רק אחרי כניסה עם סיסמה נכונה.
--  * שלושה תפקידים: admin (הכול), editor (עריכת קטלוג), viewer (קריאה, שליחת דיווחים ובקשות).
--  * מה שמסומן באתר "מוסתר מצופים" לא נשלח בכלל לצופים. הסינון נעשה כאן, בשרת.
--  * הסיסמאות נשמרות מגובבות (hash עם מלח). אחרי 8 ניסיונות שגויים נחסמת הכתובת ל-15 דקות.
-- =====================================================================

create schema if not exists vrf;
revoke all on schema vrf from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 1) טבלאות
-- ---------------------------------------------------------------------
-- מסמכים (בסגנון Firestore): collection + id + JSON. כאן נשמרים הקטלוג, החלקים, החדשות, הדיווחים ועוד.
create table if not exists vrf.docs (
  col     text  not null,
  id      text  not null,
  data    jsonb not null,
  updated timestamptz not null default now(),
  primary key (col, id)
);
create index if not exists docs_col_updated_idx on vrf.docs (col, updated desc);

create table if not exists vrf.users (
  id      text primary key,
  label   text not null check (length(btrim(label)) between 1 and 40),
  role    text not null check (role in ('admin', 'editor', 'viewer')),
  salt    text not null,
  pw_hash text not null,
  updated timestamptz not null default now()
);
create table if not exists vrf.sessions (
  token_hash text primary key,
  user_id    text not null references vrf.users(id) on delete cascade,
  expires    timestamptz not null
);
create index if not exists sessions_user_idx on vrf.sessions (user_id);
create table if not exists vrf.login_attempts (
  k            text primary key,
  fails        int not null default 0,
  first_fail   timestamptz not null default now(),
  locked_until timestamptz
);

do $$
declare t text;
begin
  foreach t in array array['docs', 'users', 'sessions', 'login_attempts'] loop
    execute format('alter table vrf.%I enable row level security', t);
    execute format('revoke all on vrf.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2) פונקציות פנימיות (לא נגישות מה-API)
-- ---------------------------------------------------------------------
create or replace function vrf.hash_pw(pw text, salt text) returns text
language plpgsql immutable set search_path = ''
as $$
declare h bytea := convert_to(salt || ':' || pw, 'UTF8'); p bytea := convert_to(pw, 'UTF8'); i int;
begin
  for i in 1..100000 loop h := sha256(h || p); end loop;
  return encode(h, 'hex');
end $$;

-- הקמה/עדכון של משתמש. מריצים רק מתוך SQL Editor (2-first-users.sql), לא נגיש ל-API.
create or replace function vrf.set_user(uid text, ulabel text, urole text, pw text) returns text
language plpgsql set search_path = ''
as $$
declare s text := replace(gen_random_uuid()::text, '-', ''); u record;
begin
  if urole not in ('admin', 'editor', 'viewer') then raise exception 'התפקיד חייב להיות admin, editor או viewer'; end if;
  if pw is null or length(pw) < (case urole when 'admin' then 10 when 'editor' then 6 else 4 end) then
    raise exception 'הסיסמה קצרה מדי (מנהל: לפחות 10 תווים, עורך: 6, צופה: 4)';
  end if;
  for u in select * from vrf.users x where x.id <> uid loop
    if vrf.hash_pw(pw, u.salt) = u.pw_hash then raise exception 'הסיסמה כבר בשימוש אצל משתמש אחר. כל משתמש חייב סיסמה שונה'; end if;
  end loop;
  insert into vrf.users (id, label, role, salt, pw_hash) values (uid, ulabel, urole, s, vrf.hash_pw(pw, s))
    on conflict (id) do update set label = excluded.label, role = excluded.role, salt = excluded.salt, pw_hash = excluded.pw_hash, updated = now();
  delete from vrf.sessions where user_id = uid;
  return 'המשתמש ' || ulabel || ' (' || urole || ') עודכן';
end $$;

-- מי מחובר כרגע (התפקיד נקרא בזמן אמת מטבלת המשתמשים, כך ששינוי תפקיד תופס מיד)
create or replace function vrf.me(t text) returns table (uid text, role text, label text)
language sql stable security definer set search_path = ''
as $$
  select u.id, u.role, u.label from vrf.sessions s join vrf.users u on u.id = s.user_id
  where s.token_hash = encode(sha256(convert_to(coalesce(t, ''), 'UTF8')), 'hex') and s.expires > now()
$$;
create or replace function vrf.rank_of(t text) returns int
language sql stable security definer set search_path = ''
as $$ select coalesce((select case m.role when 'admin' then 3 when 'editor' then 2 else 1 end from vrf.me(t) m), 0) $$;

-- הרשאות לפי אוסף ופעולה. 1=צופה, 2=עורך, 3=מנהל. null = אסור לגמרי
create or replace function vrf.col_min(c text, op text) returns int
language sql immutable set search_path = ''
as $$
  select case
    when c in ('catalog', 'parts', 'news', 'system', 'img') then (case op when 'read' then 1 else 2 end)
    when c in ('reports', 'techRequests') then (case op when 'read' then 2 when 'add' then 1 else 2 end)
    when c = 'views' then (case op when 'read' then 2 when 'delete' then 3 else null end)   -- כתיבה רק דרך vrf_view_track
    when c = 'alerts' then (case op when 'delete' then 3 else 2 end)
    when c = 'history' then (case op when 'read' then 3 when 'delete' then 3 else 2 end)
    when c = 'snapshots' then (case op when 'read' then 3 else 2 end)
    else null end
$$;

-- בודק הרשאה. מחזיר את דרגת המשתמש, או זורק שגיאה מובנת
create or replace function vrf.need(t text, c text, op text) returns int
language plpgsql stable security definer set search_path = ''
as $$
declare r int := vrf.rank_of(t); m int := vrf.col_min(c, op);
begin
  if r = 0 then raise exception 'vrf_auth'; end if;
  if m is null then
    if c in ('catalog', 'parts', 'news', 'system', 'img', 'reports', 'techRequests', 'views', 'alerts', 'history', 'snapshots') then raise exception 'vrf_denied'; end if;
    raise exception 'vrf_bad_col';
  end if;
  if r < m then raise exception 'vrf_denied'; end if;
  return r;
end $$;

create or replace function vrf.chk_id(i text) returns void
language plpgsql immutable set search_path = ''
as $$ begin if i is null or i !~ '^[A-Za-z0-9_.:-]{1,80}$' then raise exception 'vrf_bad_input'; end if; end $$;

-- בדיקת תקינות לפי סוג האוסף. תמונות: רק data:image
create or replace function vrf.chk_doc(c text, d jsonb) returns void
language plpgsql immutable set search_path = ''
as $$
begin
  if d is null or jsonb_typeof(d) <> 'object' then raise exception 'vrf_bad_input'; end if;
  if length(d::text) > 14000000 then raise exception 'vrf_too_big'; end if;
  if c = 'img' then
    if (d ->> 'd') is null or (d ->> 'd') !~ '^data:image/(jpeg|png|webp|gif);base64,' or length(d ->> 'd') > 4000000 then raise exception 'vrf_bad_image'; end if;
  end if;
end $$;

-- מזהי דגמים מוסתרים (דגם מוסתר, או כל דגם במותג מוסתר), כולל תת-קטגוריות
create or replace function vrf.hidden_mids() returns text[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct v), '{}') from (
    select jsonb_path_query(data, '$.d.brands[*].categories[*].models[*] ? (@.hidden == true).id') #>> '{}' as v from vrf.docs where col = 'catalog' and id = 'meta'
    union all select jsonb_path_query(data, '$.d.brands[*].categories[*].subCategories[*].models[*] ? (@.hidden == true).id') #>> '{}' from vrf.docs where col = 'catalog' and id = 'meta'
    union all select jsonb_path_query(data, '$.d.brands[*] ? (@.hidden == true).categories[*].models[*].id') #>> '{}' from vrf.docs where col = 'catalog' and id = 'meta'
    union all select jsonb_path_query(data, '$.d.brands[*] ? (@.hidden == true).categories[*].subCategories[*].models[*].id') #>> '{}' from vrf.docs where col = 'catalog' and id = 'meta'
  ) x
$$;

create or replace function vrf.vis_parts(d jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select case when jsonb_typeof(d -> 'parts') = 'array'
    then jsonb_set(d, '{parts}', coalesce((select jsonb_agg(p) from jsonb_array_elements(d -> 'parts') p where not coalesce((p ->> 'hidden')::boolean, false)), '[]'::jsonb))
    else d end
$$;

-- מסנן את מסמך הקטלוג לצופה: בלי מותגים, דגמים וחלקים מוסתרים
create or replace function vrf.vis_meta(m jsonb) returns jsonb
language plpgsql immutable set search_path = ''
as $$
declare b jsonb; c jsonb; sc jsonb; x jsonb; bs jsonb := '[]'::jsonb; cs jsonb; ss jsonb; ms jsonb;
begin
  if jsonb_typeof(m #> '{d,brands}') <> 'array' then return m; end if;
  for b in select * from jsonb_array_elements(m #> '{d,brands}') loop
    if coalesce((b ->> 'hidden')::boolean, false) then continue; end if;
    cs := '[]'::jsonb;
    for c in select * from jsonb_array_elements(coalesce(b -> 'categories', '[]'::jsonb)) loop
      ms := coalesce((select jsonb_agg(y) from jsonb_array_elements(coalesce(c -> 'models', '[]'::jsonb)) y where not coalesce((y ->> 'hidden')::boolean, false)), '[]'::jsonb);
      c := jsonb_set(c, '{models}', ms);
      if jsonb_typeof(c -> 'subCategories') = 'array' then
        ss := '[]'::jsonb;
        for sc in select * from jsonb_array_elements(c -> 'subCategories') loop
          ms := '[]'::jsonb;
          for x in select * from jsonb_array_elements(coalesce(sc -> 'models', '[]'::jsonb)) loop
            if coalesce((x ->> 'hidden')::boolean, false) then continue; end if;
            ms := ms || jsonb_build_array(vrf.vis_parts(x));
          end loop;
          ss := ss || jsonb_build_array(jsonb_set(sc, '{models}', ms));
        end loop;
        c := jsonb_set(c, '{subCategories}', ss);
      end if;
      cs := cs || jsonb_build_array(c);
    end loop;
    bs := bs || jsonb_build_array(jsonb_set(b, '{categories}', cs));
  end loop;
  return jsonb_set(m, '{d,brands}', bs);
end $$;

-- אחרי בדיקת הרשאה: קורא מסמך. צופה מקבל גרסה מסוננת
drop function if exists vrf.read_doc(int, text, text);
create or replace function vrf.read_doc(r int, c text, i text, hm text[] default null) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare d jsonb; hidden text[];
begin
  select x.data into d from vrf.docs x where x.col = c and x.id = i;
  if not found then return null; end if;
  if r = 1 then
    if c = 'catalog' and i = 'meta' then d := vrf.vis_meta(d);
    elsif c = 'parts' then
      hidden := coalesce(hm, vrf.hidden_mids());
      if i = any (hidden) then return null; end if;
      d := vrf.vis_parts(d);
    end if;
  end if;
  return d;
end $$;

-- ---------------------------------------------------------------------
-- 3) ה-API (הדרך היחידה לגשת לנתונים)
-- ---------------------------------------------------------------------
-- מידע ציבורי למסך הכניסה (כותרת ברוך-הבא ואזהרה). בלי שום נתון אחר
create or replace function public.vrf_public() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('ok', true,
    'configured', exists (select 1 from vrf.users where role = 'admin'),
    'welcomeTitle', m #>> '{d,welcomeTitle}', 'welcomeSub', m #>> '{d,welcomeSub}', 'disclaimer', m #>> '{d,disclaimer}')
  from (select coalesce((select data from vrf.docs where col = 'catalog' and id = 'meta'), '{}'::jsonb) as m) z
$$;
create or replace function public.vrf_version() returns int
language sql stable set search_path = '' as $$ select 1 $$;

create or replace function public.vrf_login(pw text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  hdr jsonb; ip_key text; a vrf.login_attempts; u record; got vrf.users; tok text; ttl interval; gfails int;
begin
  begin hdr := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then hdr := null; end;
  ip_key := coalesce(nullif(btrim(hdr ->> 'cf-connecting-ip'), ''), nullif(btrim(hdr ->> 'x-real-ip'), ''),
                     nullif(btrim(split_part(coalesce(hdr ->> 'x-forwarded-for', ''), ',', 1)), ''), 'unknown');
  delete from vrf.sessions where expires < now();
  delete from vrf.login_attempts where coalesce(locked_until, first_fail + interval '15 minutes') < now() - interval '1 hour';
  if not exists (select 1 from vrf.users where role = 'admin') then return jsonb_build_object('ok', false, 'reason', 'setup'); end if;

  select * into a from vrf.login_attempts where login_attempts.k = ip_key;
  if found and a.locked_until is not null and a.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'wait', ceil(extract(epoch from (a.locked_until - now())))::int);
  end if;
  select coalesce(sum(fails), 0) into gfails from vrf.login_attempts where first_fail > now() - interval '1 hour';
  if gfails >= 400 then return jsonb_build_object('ok', false, 'reason', 'locked', 'wait', 300); end if;   -- הגנה מפני ניחוש מבוזר

  if pw is not null and length(pw) between 1 and 200 then
    for u in select * from vrf.users order by role, id loop
      if vrf.hash_pw(pw, u.salt) = u.pw_hash then got := u; exit; end if;
    end loop;
  end if;

  if got.id is null then
    insert into vrf.login_attempts (k, fails, first_fail) values (ip_key, 1, now())
      on conflict (k) do update set
        fails = case when vrf.login_attempts.first_fail < now() - interval '15 minutes' then 1 else vrf.login_attempts.fails + 1 end,
        first_fail = case when vrf.login_attempts.first_fail < now() - interval '15 minutes' then now() else vrf.login_attempts.first_fail end,
        locked_until = null;
    update vrf.login_attempts set locked_until = now() + interval '15 minutes' where login_attempts.k = ip_key and fails >= 8;
    perform pg_sleep(0.4);
    return jsonb_build_object('ok', false, 'reason', 'wrong');
  end if;

  delete from vrf.login_attempts where login_attempts.k = ip_key;
  tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  ttl := case got.role when 'viewer' then interval '30 days' else interval '12 hours' end;
  insert into vrf.sessions (token_hash, user_id, expires) values (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), got.id, now() + ttl);
  return jsonb_build_object('ok', true, 'role', got.role, 'id', got.id, 'label', got.label, 'token', tok, 'expires_in', extract(epoch from ttl)::int);
end $$;

create or replace function public.vrf_logout(t text) returns jsonb
language sql security definer set search_path = ''
as $$
  with d as (delete from vrf.sessions where token_hash = encode(sha256(convert_to(coalesce(t, ''), 'UTF8')), 'hex') returning 1)
  select jsonb_build_object('ok', true)
$$;

-- בדיקה שהאסימון עדיין תקף (בטעינת האתר אחרי רענון)
create or replace function public.vrf_whoami(t text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare m record;
begin
  select * into m from vrf.me(t);
  if not found then raise exception 'vrf_auth'; end if;
  return jsonb_build_object('ok', true, 'id', m.uid, 'role', m.role, 'label', m.label);
end $$;

create or replace function public.vrf_doc_get(t text, c text, i text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare r int := vrf.need(t, c, 'read');
begin
  perform vrf.chk_id(i);
  return vrf.read_doc(r, c, i);
end $$;

-- קריאה של כמה מסמכים בבת אחת, עד תקרת נפח. מה שלא נכנס חוזר ב-rest והלקוח מבקש שוב
create or replace function public.vrf_docs_get(t text, c text, ids jsonb, max_bytes int) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare r int := vrf.need(t, c, 'read'); k text; d jsonb; docs jsonb := '{}'::jsonb; rest jsonb := '[]'::jsonb; acc bigint := 0; cap bigint := least(greatest(coalesce(max_bytes, 2000000), 100000), 8000000); hm text[];
begin
  if r = 1 and c = 'parts' then hm := vrf.hidden_mids(); end if;
  if jsonb_typeof(ids) <> 'array' or jsonb_array_length(ids) > 200 then raise exception 'vrf_bad_input'; end if;
  for k in select jsonb_array_elements_text(ids) loop
    perform vrf.chk_id(k);
    if acc >= cap and docs <> '{}'::jsonb then rest := rest || to_jsonb(k); continue; end if;
    d := vrf.read_doc(r, c, k, hm);
    if d is not null then docs := docs || jsonb_build_object(k, d); acc := acc + length(d::text); end if;
  end loop;
  return jsonb_build_object('docs', docs, 'rest', rest);
end $$;

-- שאילתה: סינון בשוויון, מיון לפי שדה (מספר או חותמת זמן), הגבלה. מחזיר [{id, data}]
create or replace function public.vrf_query(t text, c text, filters jsonb, ord text, dir text, lim int) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare r int := vrf.need(t, c, 'read'); f jsonb; w text := ''; oexpr text := 'null::numeric'; res jsonb; n int := least(greatest(coalesce(lim, 100), 1), 1000);
begin
  if filters is not null and jsonb_typeof(filters) = 'array' then
    for f in select * from jsonb_array_elements(filters) loop
      if coalesce(f ->> 'op', '==') <> '==' or (f ->> 'f') !~ '^[A-Za-z0-9_]{1,40}$' then raise exception 'vrf_bad_input'; end if;
      w := w || format(' and x.data -> %L = %L::jsonb', f ->> 'f', (f -> 'v')::text);
    end loop;
  end if;
  if ord is not null and ord <> '' then
    if ord !~ '^[A-Za-z0-9_]{1,40}$' then raise exception 'vrf_bad_input'; end if;
    oexpr := format('(case jsonb_typeof(x.data -> %L) when ''object'' then (x.data -> %L ->> ''__ts'')::numeric when ''number'' then (x.data ->> %L)::numeric else null end)', ord, ord, ord);
  end if;
  execute format(
    'select coalesce(jsonb_agg(jsonb_build_object(''id'', s.id, ''data'', s.data) order by s.o %s nulls last, s.id), ''[]''::jsonb) from (select x.id, x.data, %s as o from vrf.docs x where x.col = $1 %s order by %s %s nulls last, x.id limit %s) s',
    case when lower(coalesce(dir, 'asc')) = 'desc' then 'desc' else 'asc' end, oexpr, w, oexpr,
    case when lower(coalesce(dir, 'asc')) = 'desc' then 'desc' else 'asc' end, n) into res using c;
  return res;
end $$;

create or replace function public.vrf_doc_set(t text, c text, i text, d jsonb, merge boolean) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform vrf.need(t, c, 'write');
  perform vrf.chk_id(i); perform vrf.chk_doc(c, d);
  insert into vrf.docs (col, id, data) values (c, i, d)
    on conflict (col, id) do update set data = case when coalesce(merge, false) then vrf.docs.data || excluded.data else excluded.data end, updated = now();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.vrf_doc_update(t text, c text, i text, d jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform vrf.need(t, c, 'write');
  perform vrf.chk_id(i); perform vrf.chk_doc(c, d);
  update vrf.docs x set data = x.data || d, updated = now() where x.col = c and x.id = i;
  if not found then raise exception 'vrf_notfound'; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.vrf_doc_add(t text, c text, d jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare nid text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS') || substr(md5(random()::text), 1, 6);
begin
  perform vrf.need(t, c, 'add');
  perform vrf.chk_doc(c, d);
  insert into vrf.docs (col, id, data) values (c, nid, d);
  if c = 'snapshots' then   -- שומרים רק 10 גרסאות אחרונות
    delete from vrf.docs x where x.col = 'snapshots' and x.id not in (select y.id from vrf.docs y where y.col = 'snapshots' order by y.updated desc, y.id desc limit 10);
  end if;
  return jsonb_build_object('ok', true, 'id', nid);
end $$;

create or replace function public.vrf_doc_delete(t text, c text, i text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform vrf.need(t, c, 'delete');
  perform vrf.chk_id(i);
  delete from vrf.docs x where x.col = c and x.id = i;
  return jsonb_build_object('ok', true);
end $$;

-- מחיקת כל האוסף (איפוס לוג, התראות, צפיות). מנהל בלבד, לפי הכללים
create or replace function public.vrf_clear(t text, c text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  perform vrf.need(t, c, 'delete');
  if vrf.rank_of(t) < 3 then raise exception 'vrf_denied'; end if;
  delete from vrf.docs x where x.col = c;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'n', n);
end $$;

-- כמה פעולות בבת אחת, בעסקה אחת: [{op:'set'|'update'|'delete', col, id, data}]
create or replace function public.vrf_batch(t text, ops jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare o jsonb; c text; i text; kind text; d jsonb; n int := 0;
begin
  if jsonb_typeof(ops) <> 'array' or jsonb_array_length(ops) > 600 then raise exception 'vrf_bad_input'; end if;
  for o in select * from jsonb_array_elements(ops) loop
    c := o ->> 'col'; i := o ->> 'id'; kind := o ->> 'op'; d := o -> 'data';
    perform vrf.chk_id(i);
    if kind = 'delete' then
      perform vrf.need(t, c, 'delete');
      delete from vrf.docs x where x.col = c and x.id = i;
    elsif kind = 'set' then
      perform vrf.need(t, c, 'write'); perform vrf.chk_doc(c, d);
      insert into vrf.docs (col, id, data) values (c, i, d)
        on conflict (col, id) do update set data = case when coalesce((o ->> 'merge')::boolean, false) then vrf.docs.data || excluded.data else excluded.data end, updated = now();
    elsif kind = 'update' then
      perform vrf.need(t, c, 'write'); perform vrf.chk_doc(c, d);
      update vrf.docs x set data = x.data || d, updated = now() where x.col = c and x.id = i;
      if not found then raise exception 'vrf_notfound'; end if;
    else raise exception 'vrf_bad_input'; end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'n', n);
end $$;

-- מונה צפיות לדגם. פתוח לכל תפקיד (צופה לא יכול לכתוב ישירות לאוסף views)
create or replace function public.vrf_view_track(t text, mid text, mname text, bname text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if vrf.rank_of(t) = 0 then raise exception 'vrf_auth'; end if;
  perform vrf.chk_id(mid);
  insert into vrf.docs (col, id, data) values ('views', mid,
    jsonb_build_object('count', 1, 'modelName', left(coalesce(mname, ''), 200), 'brandName', left(coalesce(bname, ''), 200), 'lastSeen', jsonb_build_object('__ts', now_ms)))
  on conflict (col, id) do update set data = jsonb_build_object('count', coalesce((vrf.docs.data ->> 'count')::int, 0) + 1,
      'modelName', left(coalesce(mname, ''), 200), 'brandName', left(coalesce(bname, ''), 200), 'lastSeen', jsonb_build_object('__ts', now_ms)), updated = now();
  return jsonb_build_object('ok', true);
end $$;

-- ניקוי תמונות שאינן בשימוש (מנהל). לא נוגע בתמונות צעירות משעה, ובתמונות שגרסאות שמורות עדיין מפנות אליהן
create or replace function public.vrf_gc_images(t text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  if vrf.rank_of(t) = 0 then raise exception 'vrf_auth'; end if;
  if vrf.rank_of(t) < 3 then raise exception 'vrf_denied'; end if;
  with used as (
    select distinct (regexp_matches(x.data::text, 'sb:([A-Za-z0-9_-]{6,80})', 'g'))[1] as ref from vrf.docs x where x.col in ('catalog', 'parts', 'snapshots')
  )
  delete from vrf.docs g where g.col = 'img' and g.updated < now() - interval '1 hour' and g.id not in (select ref from used);
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'n', n);
end $$;

-- ---------------------------------------------------------------------
-- 4) ניהול משתמשים (מנהל בלבד, באישור סיסמת המנהל של המחובר)
-- ---------------------------------------------------------------------
-- מחזיר null אם הסיסמה נכונה, אחרת סיבה. 5 טעויות = נעילה ל-15 דקות
create or replace function vrf.confirm_admin(t text, pw text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare m record; u vrf.users; ck text := 'chg:' || left(encode(sha256(convert_to(coalesce(t, ''), 'UTF8')), 'hex'), 24); att vrf.login_attempts;
begin
  select * into m from vrf.me(t);
  if not found then raise exception 'vrf_auth'; end if;
  if m.role <> 'admin' then raise exception 'vrf_denied'; end if;
  select * into att from vrf.login_attempts where login_attempts.k = ck;
  if found and att.locked_until is not null and att.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'wait', ceil(extract(epoch from (att.locked_until - now())))::int);
  end if;
  select * into u from vrf.users where id = m.uid;
  if pw is null or length(pw) > 200 or vrf.hash_pw(pw, u.salt) <> u.pw_hash then
    insert into vrf.login_attempts (k, fails, first_fail) values (ck, 1, now())
      on conflict (k) do update set
        fails = case when vrf.login_attempts.first_fail < now() - interval '15 minutes' then 1 else vrf.login_attempts.fails + 1 end,
        first_fail = case when vrf.login_attempts.first_fail < now() - interval '15 minutes' then now() else vrf.login_attempts.first_fail end,
        locked_until = null;
    update vrf.login_attempts set locked_until = now() + interval '15 minutes' where login_attempts.k = ck and fails >= 5;
    perform pg_sleep(0.4);
    return jsonb_build_object('ok', false, 'reason', 'wrong_current');
  end if;
  delete from vrf.login_attempts where login_attempts.k = ck;
  return null;
end $$;

create or replace function public.vrf_users_list(t text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if vrf.rank_of(t) = 0 then raise exception 'vrf_auth'; end if;
  if vrf.rank_of(t) < 3 then raise exception 'vrf_denied'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'label', u.label, 'role', u.role) order by case u.role when 'admin' then 0 when 'editor' then 1 else 2 end, u.label) from vrf.users u), '[]'::jsonb);
end $$;

create or replace function public.vrf_user_save(t text, uid text, ulabel text, urole text, new_pw text, confirm_pw text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  conf jsonb; m record; ex vrf.users; target text; s text; th text := encode(sha256(convert_to(coalesce(t, ''), 'UTF8')), 'hex'); minlen int; u record; role_changed boolean := false; pw_given boolean := coalesce(new_pw, '') <> '';
begin
  conf := vrf.confirm_admin(t, confirm_pw);
  if conf is not null then return conf; end if;
  select * into m from vrf.me(t);
  ulabel := btrim(coalesce(ulabel, ''));
  if length(ulabel) < 1 or length(ulabel) > 40 then return jsonb_build_object('ok', false, 'reason', 'bad_label'); end if;
  if urole is null or urole not in ('admin', 'editor', 'viewer') then return jsonb_build_object('ok', false, 'reason', 'bad_role'); end if;
  if pw_given and length(new_pw) > 200 then return jsonb_build_object('ok', false, 'reason', 'bad_input'); end if;

  if coalesce(uid, '') = '' then
    target := 'u' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
    if not pw_given then return jsonb_build_object('ok', false, 'reason', 'need_pw'); end if;
  else
    target := uid;
    select * into ex from vrf.users where id = target;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    role_changed := ex.role <> urole;
    if ex.role = 'admin' and urole <> 'admin' and (select count(*) from vrf.users where role = 'admin') <= 1 then return jsonb_build_object('ok', false, 'reason', 'last_admin'); end if;
    if urole = 'admin' and ex.role <> 'admin' and not pw_given then return jsonb_build_object('ok', false, 'reason', 'need_pw_admin'); end if;
  end if;

  if pw_given then
    minlen := case urole when 'admin' then 10 when 'editor' then 6 else 4 end;
    if length(new_pw) < minlen then return jsonb_build_object('ok', false, 'reason', 'short_' || urole); end if;
    for u in select * from vrf.users x where x.id <> target loop
      if vrf.hash_pw(new_pw, u.salt) = u.pw_hash then return jsonb_build_object('ok', false, 'reason', 'dup_pw'); end if;
    end loop;
    s := replace(gen_random_uuid()::text, '-', '');
    insert into vrf.users (id, label, role, salt, pw_hash) values (target, ulabel, urole, s, vrf.hash_pw(new_pw, s))
      on conflict (id) do update set label = excluded.label, role = excluded.role, salt = excluded.salt, pw_hash = excluded.pw_hash, updated = now();
  else
    update vrf.users set label = ulabel, role = urole, updated = now() where id = target;
  end if;
  -- מנתקים את מי שהיה מחובר עם הסיסמה/התפקיד הישנים. המנהל שמבצע את הפעולה נשאר מחובר
  if pw_given or role_changed then delete from vrf.sessions where user_id = target and token_hash <> th; end if;
  return jsonb_build_object('ok', true, 'id', target);
end $$;

create or replace function public.vrf_user_delete(t text, uid text, confirm_pw text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare conf jsonb; m record; ex vrf.users;
begin
  conf := vrf.confirm_admin(t, confirm_pw);
  if conf is not null then return conf; end if;
  select * into m from vrf.me(t);
  select * into ex from vrf.users where id = uid;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if ex.id = m.uid then return jsonb_build_object('ok', false, 'reason', 'self'); end if;
  if ex.role = 'admin' and (select count(*) from vrf.users where role = 'admin') <= 1 then return jsonb_build_object('ok', false, 'reason', 'last_admin'); end if;
  delete from vrf.users where id = uid;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- 5) הרשאות הרצה: ה-API הציבורי (anon) יכול לקרוא רק לפונקציות vrf_*
-- ---------------------------------------------------------------------
revoke all on function vrf.hash_pw(text, text), vrf.set_user(text, text, text, text), vrf.me(text), vrf.rank_of(text), vrf.col_min(text, text),
  vrf.need(text, text, text), vrf.chk_id(text), vrf.chk_doc(text, jsonb), vrf.hidden_mids(), vrf.vis_parts(jsonb), vrf.vis_meta(jsonb),
  vrf.read_doc(int, text, text, text[]), vrf.confirm_admin(text, text) from public, anon, authenticated;

revoke all on function public.vrf_public(), public.vrf_version(), public.vrf_login(text), public.vrf_logout(text), public.vrf_whoami(text),
  public.vrf_doc_get(text, text, text), public.vrf_docs_get(text, text, jsonb, int), public.vrf_query(text, text, jsonb, text, text, int),
  public.vrf_doc_set(text, text, text, jsonb, boolean), public.vrf_doc_update(text, text, text, jsonb), public.vrf_doc_add(text, text, jsonb),
  public.vrf_doc_delete(text, text, text), public.vrf_clear(text, text), public.vrf_batch(text, jsonb), public.vrf_view_track(text, text, text, text),
  public.vrf_gc_images(text), public.vrf_users_list(text), public.vrf_user_save(text, text, text, text, text, text), public.vrf_user_delete(text, text, text) from public;
grant execute on function public.vrf_public(), public.vrf_version(), public.vrf_login(text), public.vrf_logout(text), public.vrf_whoami(text),
  public.vrf_doc_get(text, text, text), public.vrf_docs_get(text, text, jsonb, int), public.vrf_query(text, text, jsonb, text, text, int),
  public.vrf_doc_set(text, text, text, jsonb, boolean), public.vrf_doc_update(text, text, text, jsonb), public.vrf_doc_add(text, text, jsonb),
  public.vrf_doc_delete(text, text, text), public.vrf_clear(text, text), public.vrf_batch(text, jsonb), public.vrf_view_track(text, text, text, text),
  public.vrf_gc_images(text), public.vrf_users_list(text), public.vrf_user_save(text, text, text, text, text, text), public.vrf_user_delete(text, text, text) to anon, authenticated;

-- =====================================================================
-- עדכון: סל מחזור + תיקון אבטחה (מריצים פעם אחת, אחרי 1-schema.sql ו-2-first-users.sql)
--
-- מה העדכון עושה:
--  1. סל מחזור: מוסיף אוסף "trash" שרק מנהל יכול לקרוא ולכתוב בו. דגמים, קטגוריות, תתי-קטגוריות
--     ומותגים שנמחקים באתר נשמרים שם, ואפשר לשחזר אותם.
--  2. תיקון אבטחה: עד עכשיו צופה שפתח את כלי המפתחים בדפדפן יכול היה לקרוא ישירות לפונקציית השאילתה
--     (vrf_query) ולקבל גם מותגים, דגמים וחלקים שסומנו "מוסתר מצופים". מעכשיו צופה יכול לשאול רק
--     את אוספי החדשות והודעות המערכת. האתר עצמו לא הושפע, כי הוא מציג לצופים רק את מה שמותר.
--  3. ניקוי תמונות שאינן בשימוש (בתפריט ⋮) לא ימחק יותר תמונות של פריטים שנמצאים בסל המחזור.
--  4. מספר הגרסה (vrf_version) עולה ל-2.
--
-- איך מריצים: Supabase > SQL Editor > New query > הדבק את כל התוכן של הקובץ הזה > Run.
-- בטוח להרצה חוזרת. לא מוחק ולא משנה שום נתון קיים, ולא משנה סיסמאות או משתמשים.
-- =====================================================================

-- 1) הרשאות לפי אוסף: trash = מנהל בלבד (קריאה, כתיבה ומחיקה)
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
    when c = 'trash' then 3
    else null end
$$;

-- 2) תיקון האבטחה: צופה יכול לשאול רק חדשות והודעות מערכת. עורך ומנהל: כמו קודם
create or replace function public.vrf_query(t text, c text, filters jsonb, ord text, dir text, lim int) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare r int := vrf.need(t, c, 'read'); f jsonb; w text := ''; oexpr text := 'null::numeric'; res jsonb; n int := least(greatest(coalesce(lim, 100), 1), 1000);
begin
  if r < 2 and c not in ('news', 'system') then raise exception 'vrf_denied'; end if;
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

-- 3) ניקוי תמונות: תמונות שפריט בסל המחזור מפנה אליהן נשארות
create or replace function public.vrf_gc_images(t text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  if vrf.rank_of(t) = 0 then raise exception 'vrf_auth'; end if;
  if vrf.rank_of(t) < 3 then raise exception 'vrf_denied'; end if;
  with used as (
    select distinct (regexp_matches(x.data::text, 'sb:([A-Za-z0-9_-]{6,80})', 'g'))[1] as ref from vrf.docs x where x.col in ('catalog', 'parts', 'snapshots', 'trash')
  )
  delete from vrf.docs g where g.col = 'img' and g.updated < now() - interval '1 hour' and g.id not in (select ref from used);
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'n', n);
end $$;

-- 4) גרסה
create or replace function public.vrf_version() returns int
language sql stable set search_path = '' as $$ select 2 $$;

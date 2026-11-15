// ===== הגדרות האתר =====
// המפתח הזה (publishable) מיועד להיות גלוי בקוד האתר. לבדו הוא לא נותן גישה לשום נתון:
// כל הגישה עוברת דרך פונקציות במסד הנתונים שדורשות כניסה עם סיסמה (ראה sql/1-schema.sql).
// לעולם אל תכניס לכאן מפתח secret / service_role או סיסמת מסד נתונים.
window.APP_CONFIG = {
  supabaseUrl: 'https://jzwufrstnriqwltcaqiy.supabase.co',
  supabaseKey: 'sb_publishable_awC-RhP0hfcubvI2Gnix2A_vXWiCzIz',

  // צופה נשאר מחובר במכשיר (עד 30 יום). עורך ומנהל מתנתקים בסגירת הלשונית ואחרי 12 שעות.
  rememberViewer: true
};

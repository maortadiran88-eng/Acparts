// ===== הגדרות האתר =====
// המפתח הזה (publishable) מיועד להיות גלוי בקוד האתר. לבדו הוא לא נותן גישה לשום נתון:
// כל הגישה עוברת דרך פונקציות במסד הנתונים שדורשות כניסה עם סיסמה (ראה sql/schema.sql).
// לעולם אל תכניס לכאן מפתח secret / service_role או סיסמת מסד נתונים.
window.APP_CONFIG = {
  appName: 'מרכז חלקי חילוף',

  supabaseUrl: 'https://jzwufrstnriqwltcaqiy.supabase.co',
  supabaseKey: 'sb_publishable_awC-RhP0hfcubvI2Gnix2A_vXWiCzIz',

  // הסיסמאות נקבעות ב-Supabase באמצעות sql/set-passwords.sql, ולא כאן.
  rememberViewer: true,       // צופה נשאר מחובר במכשיר (עד 30 יום). מנהל מתנתק בסגירת הלשונית ואחרי 12 שעות.
  autoRefreshMinutes: 3,      // רענון אוטומטי לצופים כשחוזרים ללשונית

  maxDiagramMB: 20,           // הקבצים נשמרים במסד הנתונים ולכן נשמור על גודל סביר
  maxImageMB: 20
};

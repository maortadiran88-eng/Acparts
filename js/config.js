// ===== הגדרות האתר =====
// המפתח הזה (publishable) מיועד להיות גלוי בקוד האתר. האבטחה נאכפת במסד הנתונים (RLS),
// ולא בהסתרת המפתח. לעולם אל תכניס לכאן מפתח secret / service_role או סיסמת מסד נתונים.
window.APP_CONFIG = {
  appName: 'מרכז חלקי חילוף',

  supabaseUrl: 'https://jzwufrstnriqwltcaqiy.supabase.co',
  supabaseKey: 'sb_publishable_awC-RhP0hfcubvI2Gnix2A_vXWiCzIz',

  // שני המשתמשים ב-Supabase (Authentication > Users). הסיסמאות שלהם נקבעות שם ולא כאן.
  // המשתמש יזין בכניסה רק סיסמה, והאתר מנסה אותה מול שני החשבונות.
  // אם משנים כתובות מייל, צריך לשנות גם בפונקציה app_role() בקובץ sql/schema.sql.
  adminEmail: 'admin@parts.example.com',
  viewerEmail: 'viewer@parts.example.com',

  bucket: 'parts-files',      // חייב להתאים ל-sql/schema.sql
  rememberViewer: true,       // צופה נשאר מחובר במכשיר. מנהל תמיד מתנתק בסגירת הלשונית.
  autoRefreshMinutes: 3,      // רענון אוטומטי לצופים כשחוזרים ללשונית

  maxDiagramMB: 50,           // תקרת Supabase החינמי היא 50MB לקובץ
  maxImageMB: 20
};

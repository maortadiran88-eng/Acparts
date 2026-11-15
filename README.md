# קטלוג חלקי חילוף — VRF Parts Catalog

## מבנה הקבצים

```
📁 catalog/
  index.html          ← נקודת כניסה (CDN imports + Firebase init)
  README.md
  📁 js/
    constants.js      ← קבועים, INIT, DCOLS, DCATS
    storage.js        ← קריאות שמירה/טעינה (fbLoad, fbSave …) מעל localdb.js
    localdb.js        ← אחסון מקומי בדפדפן (IndexedDB) במקום Firebase
    helpers.js        ← פונקציות עזר + Modal + style atoms
    components.js     ← LoginScreen, HomeScreen, SidebarBrand, CartPanel, NotificationsPanel
    modals.js         ← WaEditorModal, MoveModal, CopyPartsModal, BulkMove/Delete, XlsImport, BrandMgr, ChangePwd
    ModelView.js      ← טבלת החלקים המלאה + מצב נייד
    App.js            ← קומפוננטת הבסיס, state, ניתוב, Firebase auto-save
```

## העלאה ל-GitHub Pages

1. העלה את כל התיקייה לריפוזיטורי GitHub
2. Settings → Pages → Branch: main / (root)
3. הכנס לכתובת `https://<username>.github.io/<repo>/`

## סיסמאות ברירת מחדל

| תפקיד | סיסמה |
|--------|--------|
| מנהל   | admin1234 |
| עורך   | editor1234 |
| צופה   | tadir123 |

> ניתן לשנות מההגדרות (🔑) לאחר כניסה כמנהל.

## אחסון נתונים (ללא Firebase)

האתר לא מחובר לשום שרת. הנתונים נשמרים בדפדפן (IndexedDB) של כל משתמש, ולכן שינויים שמבצעים במחשב אחד לא מופיעים אצל אחרים אוטומטית.

**איך משתפים קטלוג עם כולם:**
1. כמנהל: תפריט ⋮ ← ייצוא גיבוי (JSON)
2. שנה את שם הקובץ ל-`catalog-data.json` והעלה אותו לתיקיית האתר (ליד index.html)
3. כל מי שנכנס לראשונה (או אחרי ניקוי נתוני דפדפן) מקבל את הקטלוג הזה

לגיבוי ושחזור: ייצוא / ייבוא גיבוי (JSON) באותו תפריט.

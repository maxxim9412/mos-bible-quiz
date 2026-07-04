/*
  ╔══════════════════════════════════════════════════════════════╗
  ║  НАСТРОЙКА EMAILJS — сделайте один раз перед публикацией    ║
  ╠══════════════════════════════════════════════════════════════╣
  ║  1. Зарегистрируйтесь на emailjs.com (бесплатно)            ║
  ║  2. Email Services → Add New Service → выберите Gmail/Yandex║
  ║     Скопируйте Service ID → вставьте в EMAILJS_SERVICE_ID   ║
  ║  3. Email Templates → Create New Template (для паролей)     ║
  ║     Subject: Восстановление пароля — Библейская викторина   ║
  ║     Body: Здравствуйте, {{to_name}}!                        ║
  ║           Ваш временный пароль: {{temp_password}}           ║
  ║     → To Email: {{to_email}}                                ║
  ║     Скопируйте Template ID → вставьте в EMAILJS_TEMPLATE_ID ║
  ║  4. Email Templates → Create New Template (для отчётов)     ║
  ║     Subject: Отчёт викторины: {{period}}                    ║
  ║     Body: Викторина завершена: {{period}}                   ║
  ║           Участников: {{participants}}                       ║
  ║           {{report_text}}                                    ║
  ║     → To Email: {{to_email}}                                ║
  ║     Скопируйте Template ID → вставьте в EMAILJS_REPORT_TEMPLATE_ID ║
  ║  5. Account → General → Public Key                          ║
  ║     Вставьте в EMAILJS_PUBLIC_KEY                           ║
  ╚══════════════════════════════════════════════════════════════╝
*/

const EMAILJS_SERVICE_ID          = 'service_xbzgpbr';
const EMAILJS_TEMPLATE_ID         = 'template_8m9y5iz';   // восстановление пароля
const EMAILJS_REPORT_TEMPLATE_ID  = 'template_a4pv7ci'; // ← вставьте ID шаблона отчёта
const EMAILJS_PUBLIC_KEY          = '8OwjPHSLQARWu2NJ3';

// Email администратора для получения отчётов
const ADMIN_EMAIL = 'YOUR_ADMIN_EMAIL'; // ← вставьте свой email

// Не трогайте эту строку
if (EMAILJS_PUBLIC_KEY !== 'YOUR_PUBLIC_KEY') {
  emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
}

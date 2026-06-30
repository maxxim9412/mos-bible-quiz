/*
  ╔══════════════════════════════════════════════════════════════╗
  ║  НАСТРОЙКА EMAILJS — сделайте один раз перед публикацией    ║
  ╠══════════════════════════════════════════════════════════════╣
  ║  1. Зарегистрируйтесь на emailjs.com (бесплатно)            ║
  ║  2. Email Services → Add New Service → выберите Gmail/Yandex║
  ║     Скопируйте Service ID → вставьте в EMAILJS_SERVICE_ID   ║
  ║  3. Email Templates → Create New Template                   ║
  ║     Subject: Восстановление пароля — Библейская викторина   ║
  ║     Body (пример):                                          ║
  ║       Здравствуйте, {{to_name}}!                            ║
  ║       Ваш временный пароль: {{temp_password}}               ║
  ║       Войдите и смените пароль в настройках.                ║
  ║     → To Email: {{to_email}}                                ║
  ║     Скопируйте Template ID → вставьте в EMAILJS_TEMPLATE_ID ║
  ║  4. Account → General → Public Key                          ║
  ║     Вставьте в EMAILJS_PUBLIC_KEY                           ║
  ╚══════════════════════════════════════════════════════════════╝
*/

const EMAILJS_SERVICE_ID  = 'service_xbzgpbr';   // ← заменить
const EMAILJS_TEMPLATE_ID = 'template_8m9y5iz';  // ← заменить
const EMAILJS_PUBLIC_KEY  = '8OwjPHSLQARWu2NJ3';   // ← заменить

// Не трогайте эту строку
if (EMAILJS_PUBLIC_KEY !== 'YOUR_PUBLIC_KEY') {
  emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
}

const EMAILJS_SERVICE_ID          = 'service_xbzgpbr';
const EMAILJS_TEMPLATE_ID         = 'template_8m9y5iz';
const EMAILJS_REPORT_TEMPLATE_ID  = 'template_a4pv7ci';
const EMAILJS_PUBLIC_KEY          = '8OwjPHSLQARWu2NJ3';

const ADMIN_EMAIL = 'maxxim9422@yandex.ru'; // ← замените на ваш email

if (EMAILJS_PUBLIC_KEY !== 'YOUR_PUBLIC_KEY') {
  emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
}

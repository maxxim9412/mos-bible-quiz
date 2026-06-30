/*
  ╔══════════════════════════════════════════════════════════════════╗
  ║  НАСТРОЙКА FIREBASE — сделайте один раз перед публикацией       ║
  ╠══════════════════════════════════════════════════════════════════╣
  ║  1. Зайдите на console.firebase.google.com                      ║
  ║  2. Создайте проект (Add project)                               ║
  ║  3. Build → Realtime Database → Create database                 ║
  ║     → Start in test mode (разрешит чтение/запись)               ║
  ║  4. Project settings (⚙️) → Your apps → </> Web                 ║
  ║     → Register app → скопируйте firebaseConfig                  ║
  ║  5. Вставьте значения ниже                                      ║
  ╚══════════════════════════════════════════════════════════════════╝
*/

const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyBNwpc_IDtbYWP-n80XC1-waIh2fNNRlrQ',
  authDomain:        'mos-bible-quiz.firebaseapp.com',
  databaseURL:       'https://mos-bible-quiz-default-rtdb.firebaseio.com',
  projectId:         'mos-bible-quiz',
  storageBucket:     'mos-bible-quiz.firebasestorage.app',
  messagingSenderId: '981348049365',
  appId:             '1:981348049365:web:0fe768fbd329be285b1d5c',
};

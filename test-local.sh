#!/bin/bash
# Локальная изолированная копия викторины для тестирования.
# Firebase отключён — расписание, пользователи и результаты живут только
# в localStorage этого браузера и никак не задевают настоящий сайт/участников.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR="$DIR/.test-local"
PORT=8765

mkdir -p "$TEST_DIR"
cp "$DIR"/index.html "$DIR"/app.js "$DIR"/data.js "$DIR"/style.css "$DIR"/emailjs-config.js "$TEST_DIR"/

cat > "$TEST_DIR/firebase-config.js" <<'EOF'
const FIREBASE_CONFIG = { apiKey: 'YOUR_API_KEY' };
EOF

echo "Тестовая копия готова: $TEST_DIR"
echo "Открывается на http://localhost:$PORT"
echo "Вход админом: admin / admin123"
echo "Расписание можно ставить любое — оно не уйдёт в настоящую базу."
echo "Остановить сервер — Ctrl+C"
echo

cd "$TEST_DIR" && python3 -m http.server "$PORT"

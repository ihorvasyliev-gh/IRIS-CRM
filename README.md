# IRIS-CRM

Расширение Chrome, которое берёт студента из CCP CRM (Supabase) и заполняет форму **New Individual** в IRIS (SICAP, Dynamics 365). Сохраняете форму вы сами.

## Установка

1. Скачайте репозиторий (Code → Download ZIP) и распакуйте.
2. Откройте `chrome://extensions`, включите **Developer mode**.
3. **Load unpacked** → выберите папку `extension`.
4. Закрепите значок «CRM → IRIS» на панели; клик по нему открывает боковую панель.

## Первый запуск

1. Введите **Supabase URL** и **anon key** CRM (Supabase → Project Settings → API, или `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` из настроек сайта CRM). Это делается один раз.
2. Войдите тем же email и паролем, что и в CRM. Роль viewer студентов не видит.

## Как пользоваться

1. В IRIS нажмите **New** (откроется New Individual).
2. В панели найдите человека по имени, email, телефону или Eircode. Список живой: изменения в CRM появляются сразу.
3. Выберите его и нажмите **Fill IRIS form**.
4. Проверьте форму, выберите адрес из подсказок Auto Address, дозаполните остальное и сохраните.

## Что заполняется

| CRM | IRIS |
| --- | --- |
| first_name | First Name |
| last_name | Last Name |
| phone (+353… → 08…) | Mobile No. |
| email | Email |
| eircode | Eircode, и вводится в Auto Address |
| dob | Date of Birth (вкладка Registration & Status) |
| самая ранняя запись на курс (enrollments.created_at) | Date of Registration Meeting |
| — | CAB/Lot: единственный доступный вариант, а если их несколько, то Cork City (17-1). Уже выбранный не меняется |

Поля ищутся по подписи на форме через клиентский API Dynamics (`Xrm.Page`). Если IRIS переименует поле, панель покажет «field not found».

## Разработка

```
npm test
```

`extension/vendor/supabase.js` это сборка `@supabase/supabase-js@2.45.4` (UMD), без шага сборки.

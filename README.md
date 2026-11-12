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
| eircode | Eircode, и вводится в Auto Address; если подсказка одна, она выбирается сама |
| dob | Date of Birth (вкладка Registration & Status) |
| самая ранняя запись на курс (enrollments.created_at) | Date of Registration Meeting |
| — | CAB/Lot: единственный доступный вариант, а если их несколько, то Cork City (17-1). Уже выбранный не меняется |

Поля ищутся по подписи на форме через клиентский API Dynamics (`Xrm.Page`). Если IRIS переименует поле, панель покажет «field not found».

## Разработка

```
npm test
```

`extension/vendor/supabase.js` это сборка `@supabase/supabase-js@2.45.4` (UMD), без шага сборки.

## Individual Intervention

На форме **New Individual Intervention** выберите человека в панели и нажмите:

- **Registration**: Action «(год) 09 SUPPORTS TO NEW ARRIVALS» (год первой регистрации), LDC Staff Member (вы, если ещё не выбран), Intervention Type «One-to-one meeting», Date of Intervention = First registered, Support Type «Career guidance», Case Notes «Reg», Personal Plan Agreed, «Has there been a change…» = No.
- **Course**: Action (текущий год), LDC Staff Member, Intervention Type «Labour market related course». Остальное заполняете сами.

## Job outcome

Когда человек ответил в аутком-опросе CRM, что работает, под кнопками Registration и Course появляется блок **Job outcome**. Сверху его собственный ответ, например «Lidl warehouse», Part-time, since March 2026. Ниже то, что пойдёт в IRIS:

- **Occupational group**. Панель предлагает группу по словам ответа (английским, украинским, русским) и пишет, по какому слову. Под списком кнопки с другими подходящими группами, а в самом списке все группы IRIS. Если угадать не из чего, поле остаётся пустым.
- **Employment start**. В CRM хранится только месяц, поэтому ставится 1-е число. День можно поправить, дата пишется как в IRIS: дд/мм/гггг.
- **Contract type**. Список берётся из IRIS.
- **Date of intervention**. День, когда человек ответил на опрос.

Кнопка **Fill job outcome** на форме New Individual Intervention заполняет Action (по году интервеншна), LDC Staff Member, Date of Intervention, Case Notes (если там пусто; например `Outcome: working part-time since March 2026 (“Lidl warehouse”)`), «Has there been a change…» = Yes, Current Economic Status (Employed - Full-Time или Employed - Part-Time), Employment Start Date, Occupational group и Contract Type. Intervention Type и Support Type выбираете сами.

### Что запоминается

Группа, которую вы выбрали и отправили в IRIS, запоминается для этого ответа: следующий человек с таким же ответом получит её сразу. Ответ, внутри которого есть уже знакомый («Musgrave, Ballycurreen» после «Musgrave»), получит её как подсказку. Contract type запоминается отдельно для full-time и part-time. Память хранится в этом браузере.

Списки Occupational group и Contract Type панель читает с открытой формы IRIS, поэтому они всегда такие же, как там. Пока форма ни разу не открывалась, для Occupational group показывается встроенный список из 25 групп.

Словарь слов для подсказок лежит в `extension/occupations.js`.

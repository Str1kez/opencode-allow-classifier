# opencode-allow-classifier

Плагин разрешений для OpenCode V2. Оставляет на все shell-вызовы `ask`, а потом
сам понижает до `allow` безопасные: по allowlist, гардам и классификатору.
`sudo`, установка пакетов, `git push`, `rm` вне cwd и миграции остаются
человеку.

Плагин видит только `ask`. `deny` выносится до него и не пересматривается,
`allow` ему не нужен: понижать нечего.

## Что делает

- Read-only команды внутри проекта перестают спрашивать: их отдаёт allowlist,
  а гарды закрывают секреты, чтение вне cwd и запись.
- Неизвестную команду оценивает модель вероятностью безопасности: выше
  порога — `allow`, ниже — `ask`.
- Опасные и необратимые команды уходят человеку всегда, модель их не видит.
- Ошибка, таймаут или недоступная модель оставляют `ask`: цена ошибки —
  не ложный `allow`.

## Установка

Нужен OpenCode 2.2.x с API плагинов 2.2.x. Пакет не опубликован и ставится
локальным путём; скилл сам подставит путь к репозиторию.

Ставится скиллом `allow-classifier-install`. Открой этот репозиторий в OpenCode
и попроси агента:

> Вызови скилл `allow-classifier-install` и помоги установить плагин
> `opencode-allow-classifier`.

Скилл сам подберёт конфиг, покажет diff и проверит результат:

- поставит catch-all `ask` первым shell-правилом, deny после него и объект
  плагина с опциями;
- по умолчанию запишет глобальный `$XDG_CONFIG_HOME/opencode/opencode.jsonc`,
  иначе `~/.config/opencode/opencode.jsonc`;
- `--project` или `--config` использует только по явной просьбе;
- повторный запуск ничего не дублирует и сохраняет комментарии;
- при неверном порядке правил остановится и покажет diff;
- `rollback` снимет только добавленное и только по явной просьбе.

После установки скилл печатает чек-лист живой проверки. Коротко: `ls`
проходит без подтверждения и появляется в аудите как `allow`/`allowlist`,
`sudo -n true` спрашивает, в TUI есть `/classifier`.

### Вручную

Если агент недоступен, те же правила можно поставить руками. Порядок важен:
побеждает последнее совпавшее правило, поэтому catch-all идёт первым, deny —
после него.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git push --force*", "effect": "deny" },
    { "action": "shell", "resource": "git push -f*", "effect": "deny" },
    { "action": "shell", "resource": "git reset --hard*", "effect": "deny" },
    { "action": "shell", "resource": "rm -rf*", "effect": "deny" },
    { "action": "shell", "resource": "*--no-verify*", "effect": "deny" },
    { "action": "shell", "resource": "*--dangerously-skip-permissions*", "effect": "deny" }
  ],
  "plugins": [
    {
      "package": "/абсолютный/путь/к/opencode-allow-classifier",
      "options": {
        "enabled": true,
        "threshold": 0.9,
        "timeout_ms": 3000,
        "include_system_context": false
      }
    }
  ]
}
```

`package` указывает на каталог с `package.json`, а не на `src/index.ts`:
хост читает `exports`. Плагин подключается объектом, иначе `options` не дойдут
до серверной части. Полный разбор конфига и политики — в
[docs/permissions.md](docs/permissions.md).

## Скиллы

В репозитории два скилла. OpenCode находит их сам, когда открыт в этом
репозитории: домашний конфиг, симлинки и запись в `skills` не нужны.

- `allow-classifier-install` — установка, `inspect`, `verify` и `rollback`.
  Только он пишет конфиг.
- `allow-classifier-analyze` — разбор аудита: кластеры `ask`, рычаги и
  рекомендации. Только читает, политику не меняет.

### `allow-classifier-analyze`

Группирует `ask` по сигнатуре команды и показывает, где политика мешает
работе. Отчёт идёт в чат; файл создаётся только по явной просьбе, потому что
в аудите лежит текст последних сообщений пользователя.

```sh
npm run report
npm run report -- --since=7d --source=model --json
npm run report -- --rule='guard:*'
```

Окно по умолчанию — 30 дней. `--since` принимает `YYYY-MM-DD` или `<n>d`,
`--config` задаёт конфиг с `audit_dir` и `threshold`, `--audit-dir`
переопределяет каталог, `--source` и `--rule` сужают выборку. Аудит `sandbox/`
и `sandbox-runtime/` по умолчанию исключён. Полный список флагов — в
[SKILL.md](.opencode/skills/allow-classifier-analyze/SKILL.md).

## Опции

| Опция | Тип | По умолчанию | Поведение |
|---|---|---|---|
| `enabled` | boolean | `true` | Kill switch. Выключает только литеральный `false`: плагин не регистрирует хук, RPC и `/classifier`. |
| `model` | string | не задана | Модель классификатора вида `provider/model`. Без опции: оверрайд из `/classifier` → `opencode/jev-1.13-free`. |
| `threshold` | number | `0.9` | Порог вероятности в `(0, 1]`. `probability >= threshold` даёт `allow`. |
| `timeout_ms` | integer | `3000` | Общий бюджет вызовов модели в миллисекундах, от 1 до 60000. Включает повтор. |
| `include_system_context` | boolean | `false` | Отправлять последнее system-сообщение сессии в промпт. Только литеральный `true`. |
| `audit_dir` | string | state-каталог OpenCode | Куда писать `evaluate-YYYY-MM.jsonl`. |

Невалидное значение не ломает плагин: оно игнорируется, применяется дефолт.
`model` должна быть decision-моделью: чат-модель не отвечает на операцию
`decisions`, и каждый вызов останется `ask`.

## Как это работает

1. **Hard-ask.** `sudo`, установка пакетов, `git push`, `rm` вне cwd и
   миграции сразу получают `ask`; модель не вызывается.
2. **Allowlist с гардами.** Read-only команды внутри cwd разрешаются без
   модели. Гард отменяет allowlist на секретах, чтении вне cwd, записи,
   подстановках и подозрительных флагах.
3. **Кэш.** Повтор той же команды в том же cwd не вызывает модель. TTL —
   30 минут, до 500 записей; ошибки не кэшируются.
4. **Классификатор.** Неизвестная команда уходит в decision-модель.
   `allow`, если вероятность безопасности `>= threshold`, иначе `ask`.
5. **Ошибка — это `ask`.** Таймаут, недоступный провайдер и пустой набор
   ресурсов не понижаются.

Компаунд оценивается целиком: одна небезопасная часть оставляет `ask` всему
вызову. Полные списки правил, гардов и остаточные риски — в
[docs/permissions.md](docs/permissions.md).

## `/classifier`

Команда в TUI открывает пикер decision-моделей. Текущая модель подсвечена,
Jev идёт категорией `System One`, выключенные скрыты. Выбор сохраняется в
серверном хранилище и переживает рестарт, но опция `model` в конфиге
побеждает: тост предупредит, что эффективная модель не изменилась. В headless
пикера нет, но сохранённый выбор виден серверной части.

## Аудит и приватность

Каждое решение пишется строкой JSON в
`$XDG_STATE_HOME/opencode/evaluate-YYYY-MM.jsonl`, файл на месяц. Каталог
переопределяется опцией `audit_dir`.

В аудите есть `task` — текст последнего сообщения пользователя, поэтому
отчёт по умолчанию печатается в чат, а не пишется в файл. Текст
system-сообщения в аудит не попадает никогда: только хеш и длина.
`include_system_context` по умолчанию выключен: system-текст может содержать
внутренние данные, а классификатор может работать на внешнем провайдере.
Риски — в [ADR-0003](docs/adr/0003-system-context-in-classifier.md).

## Диагностика

### Плагин не загрузился

`package` ведёт на `src/index.ts` вместо корня пакета, версия API не 2.2.x или
в опциях `enabled: false`. V2 подхватывает исправленный конфиг сам; если
плагин не появился, форсируй `/reload`.

### `ls` всё равно спрашивает

Плагин не активен, `enabled: false`, нет catch-all `ask` или сработал гард
(путь вне cwd, секрет в аргументах, редирект). В аудите будет `ask` с
`source: allowlist` и `rule: guard:*`.

### Классификатор всегда оставляет `ask`

Смотри аудит: `probability` ниже `threshold`, `source: error` с
`rule: classifier:provider` или `classifier:timeout`, либо в поле `model`
стоит чат-модель. Выбери decision-модель через `/classifier` или опцией
`model`.

### Нет `/classifier`

Команда регистрируется только в TUI и только при включённом плагине. После
смены `enabled` V2 перезагружает плагин сам, `/reload` — принудительный путь.

## Документация

- [docs/permissions.md](docs/permissions.md): политика, конфиг, гарды, RPC,
  остаточные риски.
- [GLOSSARY.md](GLOSSARY.md): термины предметной области.
- [sandbox/README.md](sandbox/README.md): тесты и смоуки в контейнере.
- [CHANGELOG.md](CHANGELOG.md): история изменений.
- [ADR-0001](docs/adr/0001-shell-permission-classifier.md),
  [ADR-0002](docs/adr/0002-model-config-precedence.md),
  [ADR-0003](docs/adr/0003-system-context-in-classifier.md): решения.
- Спека: [issue #1](https://github.com/Str1kez/opencode-allow-classifier/issues/1).

# opencode-allow-classifier

Плагин разрешений для OpenCode V2. Оставляет на все shell-вызовы `ask`, а потом
сам понижает до `allow` безопасные: по allowlist, гардам и классификатору.
Всё, что не понижено, остаётся `ask`; ошибка, таймаут или недоступная модель
тоже дают `ask`, а не ложный `allow`.

Часть решений плагин не принимает: `sudo`, установка пакетов, `git push`, `rm`
вне cwd и миграции уходят человеку всегда. `cd` и доступ за пределы проекта
проверяются правилом `external_directory` до плагина — тоже подтверждение.

## Что делает

- Read-only команды внутри проекта перестают спрашивать: их отдаёт allowlist,
  а гарды закрывают секреты, чтение вне cwd и запись.
- Неизвестную команду оценивает модель вероятностью безопасности: выше
  порога — `allow`, ниже — `ask`.

## Установка

Нужен OpenCode 2.2.x с API плагинов 2.2.x. Пакет не опубликован и ставится
локальным путём; скилл сам подставит путь к репозиторию.

Открой этот репозиторий в OpenCode и попроси агента:

> Вызови скилл `allow-classifier-install` и помоги установить плагин
> `opencode-allow-classifier`.

Скилл покажет diff до записи, проверит результат после и откатит ровно
добавленное по явной просьбе. Если в проекте есть свои безопасные команды,
`trusted_commands` расширяет allowlist префиксами вида `npm test`; границы
опции — в [docs/permissions.md#trusted_commands](docs/permissions.md#trusted_commands).

Опция читается из конфига, в котором объявлен плагин: глобальная установка
действует на все проекты, `install --project` пишет `./opencode.jsonc` и
ограничивает `trusted_commands` текущим проектом.

Проверка после установки: `ls` проходит без подтверждения, `sudo -n true`
спрашивает, в TUI есть `/classifier`.

Если агент недоступен, добавь в `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "external_directory", "resource": "*", "effect": "ask" }
    // Deny-правила и полная политика — в docs/permissions.md.
  ],
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-allow-classifier",
      "options": { "trusted_commands": ["npm test", "npm run typecheck"] }
    }
  ]
}
```

## Документация

- [docs/permissions.md](docs/permissions.md): политика, конфиг, гарды,
  остаточные риски.
- [docs/diagnostics.md](docs/diagnostics.md): что смотреть, когда плагин
  молчит или спрашивает лишнее.
- [.opencode/skills/README.md](.opencode/skills/README.md): скиллы установки
  и разбора аудита.
- [sandbox/README.md](sandbox/README.md): контейнер и приёмочный чек-лист.
- [CHANGELOG.md](CHANGELOG.md): история изменений.

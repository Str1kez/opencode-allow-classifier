# Политика разрешений shell

Единственное место, где живёт политика. В репозитории плагина — только этот
документ; правки конфига делаются в dotfiles и повторяют фрагмент ниже.

## Принцип

`shell: * → ask` заменяет точечные ask-правила. Каждый shell-вызов сначала
требует подтверждения, а плагин понижает безопасные до `allow`. Deny-правила
стоят после catch-all: они выносятся до плагина, и хук для них не вызывается
вообще, поэтому классификатор не может отменить запрет.

Порядок правил важен: побеждает **последнее** совпавшее правило.

## `opencode.jsonc`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    // Catch-all: всё, что не поймано ниже, уходит на подтверждение.
    { "action": "shell", "resource": "*", "effect": "ask" },

    // Запреты стоят после catch-all и не пересматриваются плагином.
    { "action": "shell", "resource": "git push --force*", "effect": "deny" },
    { "action": "shell", "resource": "git push -f*", "effect": "deny" },
    { "action": "shell", "resource": "git reset --hard*", "effect": "deny" },
    { "action": "shell", "resource": "rm -rf*", "effect": "deny" },
    { "action": "shell", "resource": "*--no-verify*", "effect": "deny" },
    { "action": "shell", "resource": "*--dangerously-skip-permissions*", "effect": "deny" }
  ],
  "plugins": [
    {
      "package": "@str1kez/opencode-allow-classifier",
      "options": {
        "enabled": true
      }
    }
  ]
}
```

Плагин подключается объектом с `options`, иначе `ctx.options` пустой. Пока
пакет не опубликован, в `package` указывается локальный путь к `src/index.ts`.

## Что делает плагин

1. **Hard-ask** — вердикт `ask`, модель не вызывается: `sudo`, установка
   пакетов (`npm`/`pnpm`/`yarn`/`pip`/`uv pip`/`brew`), `git push`, `rm`
   с путём вне cwd, миграции (`alembic upgrade`, `prisma migrate`, `goose`,
   `flyway`).
2. **Allowlist с гардом** — `allow` без модели: `ls`, `pwd`, `cat`, `head`,
   `tail`, `wc`, `file`, `stat`, `du`, `df`, `which`, `echo`, `date`,
   `whoami`, `uname`, `rg`, `grep`, `jq`, `git status`, `git diff`, `git log`,
   `git show`, `git branch` (только листинговые флаги), `git remote -v`,
   `git rev-parse`, `git blame`, `git stash list`. `sed`, `awk`, `find`, `env`
   в allowlist не входят.
3. **Ask по умолчанию** — всё остальное, пока не появится классификатор.

Гард отменяет allowlist: `.env`, `.ssh`, `id_rsa`, `credentials`, `/etc/`,
любой редирект `>`/`>>`, `tee`, `-o`/`--output`, `rg --pre`, а также
шелл-операторы и подстановки внутри одного ресурса.

Компаунд (`&&`, `|`) оценивается целиком: если хотя бы один ресурс не прошёл,
весь вызов уходит на подтверждение.

## Аудит

Каждое решение по shell-вызову пишется в
`$XDG_STATE_HOME/opencode/evaluate-YYYY-MM.jsonl` (по умолчанию
`~/.local/state/opencode/`), файл на месяц. Поля: время, session, agent, cwd,
resources, сработавшее правило, вердикт, источник (`hard-ask`, `allowlist`,
`default`; позже `cache`, `model`, `error`), вероятность, модель, латентность,
текст задачи. Ошибка записи не влияет на вердикт. Каталог переопределяется
опцией `audit_dir`.

## Kill switch

`"enabled": false` — плагин не регистрирует хук вообще. Catch-all остаётся,
поэтому `ls` снова требует подтверждения. Это же поведение при сбое плагина:
любая ошибка оставляет `ask`, `deny` не пересматривается.

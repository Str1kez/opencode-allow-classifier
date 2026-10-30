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

1. **Hard-ask** — вердикт `ask`, модель не вызывается: `sudo`/`doas`/
   `sudoedit`, установка пакетов (`npm`/`pnpm`/`yarn`/`pip`/`uv`/`cargo`/
   `brew`, включая `npm ci`, голые `yarn`/`pnpm`, `python -m pip install`,
   `uv sync`, `cargo install`, `brew upgrade`), `git push`, `rm` с путём вне
   cwd, миграции (`alembic upgrade`, `prisma migrate`, `goose`, `flyway`).
   Программа ищется за env-префиксами (`FOO=1`, `env`, `nohup`, `command`,
   `time`, `\`), а у git пропускаются глобальные флаги (`-C`, `-c`,
   `--no-pager`, `--git-dir`). Поэтому `git -C /tmp push` и `FOO=1 sudo`
   остаются hard-ask.
2. **Allowlist с гардом** — `allow` без модели: `ls`, `pwd`, `cat`, `head`,
   `tail`, `wc`, `file`, `stat`, `du`, `df`, `which`, `echo`, `date`,
   `whoami`, `uname`, `rg`, `grep`, `jq`, `git status`, `git diff`, `git log`,
   `git show`, `git branch` (только листинговые флаги), `git remote -v`,
   `git rev-parse`, `git blame`, `git stash list`. `sed`, `awk`, `find`, `env`
   в allowlist не входят.
   Allowlist действует только на доказуемо read-only чтение **внутри cwd**.
   Позиционный аргумент-путь (содержит `/`, начинается с `~`, равен `.` или
   `..`) резолвится лексически с разворотом `~` и `..`; путь вне рабочего
   каталога уходит в `ask`. `rg`/`grep` без пути по умолчанию ищут в cwd —
   это разрешено. Программа, вызванная через путь (`./cat`,
   `/tmp/evil/git`), разрешается только из доверенных каталогов `/bin`,
   `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `/opt/homebrew/sbin`,
   `/usr/sbin`, `/sbin`. Голое имя без `/` считается системным: PATH не
   резолвится, лишний I/O в решателе не нужен.
3. **Ask по умолчанию** — всё остальное, пока не появится классификатор.

Гард отменяет allowlist:

- секреты: `.env`, `.ssh`, `id_rsa`/`id_ed25519`/`id_ecdsa`, `credentials`,
  `*.pem`, `*.key`, `*.p12`, `.netrc`, `.npmrc`, `.yarnrc`, `.pgpass`,
  `.git-credentials`, `.git/` (креды в `.git/config`), `.docker/config.json`,
  `.kube/config`,
  `.aws/`, `.azure/`, `.config/gcloud`, `.config/gh`, `.config/solana`,
  `.config/opencode`, `.local/share/opencode`, `.gnupg`, `.password-store`,
  `.vault-token`, `Library/Keychains`, `.zsh_history`, `.bash_history`,
  `.gitconfig`, `/etc/`, `/proc/`, `secrets`, и `jq env` (дамп окружения);
- чтение вне cwd: любой позиционный аргумент-путь вне рабочего каталога —
  `cat ~/notes.txt`, `cat ../x`, `ls ../../..`, `du -a /`;
- недоверенная программа по пути: `./cat`, `/tmp/evil/git` — вердикт
  `guard:untrusted-binary`;
- рекурсивный поиск, который читает файлы, не названные в argv:
  `rg -u`/`-uuu`/`-a`/`--hidden`/`--no-ignore*`/`--binary`/`--follow`
  (`guard:rg-unrestricted`) и `grep -r`/`-R` с корнем в cwd
  (`guard:recursive-search`);
- запись: любой редирект `>`/`>>`, `tee`, `-o`/`--output`;
- исполнение чужих программ: `rg --pre`, `git --ext-diff`/`--textconv`;
- чтение файла в обход позиционного аргумента: `--contents`, `--slurpfile`,
  `--rawfile`, `--from-file`, `jq -f` (jq-программа может напечатать `env`);
- команды, которые меняют состояние, притворяясь чтением: `date -s`/
  `--set`, `tail -f`/`-F`/`--follow`;
- вечное или блокирующее чтение: `/dev/urandom`, `/dev/random`, `/dev/zero`,
  `/dev/stdin`, `/dev/fd/`, `cat -`;
- управляющие байты: git-формат `%x` и литеральный ESC (OSC 52 — клипборд,
  CSI — подмена экрана);
- шелл-синтаксис внутри ресурса: операторы, подстановки и любые
  метасимволы ``; \n & | ` $ ( ) { } < > \ ! * ? [ ]``.

Гард смотрит на сырой текст, на текст без кавычек (`cat ".en""v"` — это
`cat .env`) и на склеенные токены. Метасимволы проверяются по сырому
ресурсу: токенизатор приклеивает `;` к предыдущему слову, и без этого
`cat x;git push --force` проходил бы как `cat`. Хвостовые пробельные
символы и переводы строк перед этой проверкой срезаются: сканер иногда
отдаёт ресурс с `\n` на конце, и `cat a\n` не должен спрашивать. Внутренний
перевод строки по-прежнему `ask`.

Компаунд (`&&`, `|`) оценивается целиком: если хотя бы один ресурс не прошёл,
весь вызов уходит на подтверждение.

## Границы allowlist и остаточный риск

Гард по путям лексический: он разворачивает `~` и `..`, но не делает
`realpath` и не ходит в файловую систему. Симлинк внутри cwd, указывающий
наружу, пройдёт проверку — это принятый остаток: резолв симлинков стоил бы
I/O на каждом решении.

Рекурсивный поиск закрыт не полностью:

- `rg` без флагов пропускает скрытые файлы и уважает ignore-файлы, поэтому
  `.env` он не читает. Но не скрытый и не проигнорированный файл с секретом
  (`server.key`, `credentials.json`) `rg TODO` всё равно просканирует —
  гард по подстроке срабатывает только когда путь назван в argv;
- `grep -r` с корнем в cwd спрашивает, но `grep -rn TODO src` разрешён:
  внутри `src` может лежать свой `.env` или ключ. Мы ограничиваем корень
  поиска, а не содержимое дерева;
- `find` в allowlist не входит, поэтому рекурсивные обходы через него
  остаются `ask`.

Доверенные каталоги — данные политики, а не проверка подписи: подмена
бинарника в `/usr/bin` или шим раньше в `PATH` (для голого имени) вне
модели угроз плагина.

Гард осознанно шумный: `rg "foo|bar"`, `rg 'a;b'`, `git log --grep='a>b'`,
`date +%x` и `grep -r . .` спрашивают. Ложный `ask` стоит одного нажатия,
ложный `allow` — исполнения команды. Разбор таких случаев — задача
классификатора из #4.

## Изменения поведения

- `cat ~/notes.txt`, `cat ../x`, `ls ../../..`, `rg TODO ~` теперь
  спрашивают: allowlist больше не читает вне проекта.
- `./cat README.md` и `/tmp/evil/ls` спрашивают: локальный шим с именем
  read-only команды больше не исполняется молча.
- `rg -uuu -a . .`, `rg --hidden TODO`, `grep -r . .` спрашивают: рекурсия
  не читает секреты, которых нет в argv.
- `cat ~/.vault-token`, `cat ~/.gnupg/secring.gpg`,
  `cat ~/.local/share/opencode/auth.json`, `cat .git/config`,
  `cat server.key` спрашивают.
- `git log --format=%x1b`, `date -s`, `cat /dev/urandom`, `tail -f` спрашивают.
- `cat README.md\n` (хвостовой перевод строки от сканера) больше не
  спрашивает.

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

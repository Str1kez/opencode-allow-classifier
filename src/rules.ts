/**
 * Rule tables. Everything a rule can decide lives here as data; `policy.ts` only walks the tables.
 * Adding a command or a secret guard means adding an entry, not touching the pipeline.
 */
import { FIND_WRITE_PREDICATES } from "./find.ts";

/** A command shape that always goes to the human, before the model is ever considered. */
export interface HardAskRule {
  /** Stable id written to the audit log. */
  readonly name: string;
  /** Program names, compared with `basename`, so `/usr/bin/sudo` matches `sudo`. */
  readonly programs: readonly string[];
  /**
   * Accepted token runs right after the program; any one of them is enough. Absent means the program
   * alone triggers the rule. `uv pip install` is `["pip", "install"]` under program `uv`.
   */
  readonly arguments?: readonly (readonly string[])[];
  /** Only fires when the program has no arguments: bare `yarn`/`pnpm` install by default. */
  readonly bare?: boolean;
  /** Extra predicate applied to the operands; only `rm` uses it today. */
  readonly scope?: "outside-cwd";
}

/**
 * Commands that are read-only no matter the arguments, except where a whitelist is declared.
 * `sed`, `awk`, `find` and `env` are deliberately absent: they execute or rewrite.
 */
export interface AllowlistRule {
  /** Stable id written to the audit log. */
  readonly name: string;
  /** Tokens that must open the segment. The first token is compared by basename. */
  readonly prefix: readonly string[];
  /** Reject anything past the prefix; `git remote -v add …` is not a listing. */
  readonly exact?: boolean;
  /** When set, every token past the prefix must be one of these. Blocks `git branch -D main`. */
  readonly allowedTokens?: readonly string[];
}

export const HARD_ASK_RULES: readonly HardAskRule[] = [
  // Privilege escalation. `doas` is the OpenBSD sudo, `sudoedit` edits as root.
  { name: "sudo", programs: ["sudo", "doas", "sudoedit"] },

  // Package installation: reaches the network and rewrites the environment.
  { name: "npm-install", programs: ["npm", "pnpm", "yarn"], arguments: [["install"], ["i"], ["add"], ["ci"]] },
  // Bare `yarn` and `pnpm` install the lockfile without any subcommand.
  { name: "npm-install", programs: ["pnpm", "yarn"], bare: true },
  { name: "pip-install", programs: ["pip", "pip3"], arguments: [["install"]] },
  // `python -m pip install` reaches the same installer through the interpreter.
  {
    name: "pip-install",
    programs: ["python", "python3"],
    arguments: [
      ["-m", "pip", "install"],
      ["-m", "pip3", "install"],
    ],
  },
  { name: "uv-install", programs: ["uv"], arguments: [["pip", "install"], ["add"], ["sync"]] },
  { name: "cargo-install", programs: ["cargo"], arguments: [["install"]] },
  { name: "brew-install", programs: ["brew"], arguments: [["install"], ["upgrade"]] },

  // Publishing state outside the machine.
  { name: "git-push", programs: ["git"], arguments: [["push"]] },

  // Irreversible deletion outside the working directory.
  { name: "rm-outside-cwd", programs: ["rm"], scope: "outside-cwd" },

  // Schema migrations: change shared state and are hard to undo.
  { name: "alembic-migration", programs: ["alembic"], arguments: [["upgrade"]] },
  { name: "prisma-migration", programs: ["prisma"], arguments: [["migrate"]] },
  { name: "goose-migration", programs: ["goose"] },
  { name: "flyway-migration", programs: ["flyway"] },
];

export const ALLOWLIST_RULES: readonly AllowlistRule[] = [
  { name: "ls", prefix: ["ls"] },
  { name: "pwd", prefix: ["pwd"] },
  { name: "cat", prefix: ["cat"] },
  { name: "head", prefix: ["head"] },
  { name: "tail", prefix: ["tail"] },
  { name: "wc", prefix: ["wc"] },
  { name: "file", prefix: ["file"] },
  { name: "stat", prefix: ["stat"] },
  { name: "du", prefix: ["du"] },
  { name: "df", prefix: ["df"] },
  { name: "which", prefix: ["which"] },
  { name: "echo", prefix: ["echo"] },
  { name: "date", prefix: ["date"] },
  { name: "whoami", prefix: ["whoami"] },
  { name: "uname", prefix: ["uname"] },
  { name: "rg", prefix: ["rg"] },
  { name: "grep", prefix: ["grep"] },
  // `find` itself only walks; the guard below validates the program it spawns after `-exec`.
  { name: "find", prefix: ["find"] },
  { name: "jq", prefix: ["jq"] },
  { name: "git-status", prefix: ["git", "status"] },
  { name: "git-diff", prefix: ["git", "diff"] },
  { name: "git-log", prefix: ["git", "log"] },
  { name: "git-show", prefix: ["git", "show"] },
  {
    name: "git-branch",
    prefix: ["git", "branch"],
    // `git branch -D main` deletes, `git branch feature` creates. Only listing flags pass.
    allowedTokens: ["-a", "-r", "-v", "-vv", "-l", "--all", "--remotes", "--verbose", "--list", "--show-current", "--no-color"],
  },
  { name: "git-remote-v", prefix: ["git", "remote", "-v"], exact: true },
  { name: "git-rev-parse", prefix: ["git", "rev-parse"] },
  { name: "git-blame", prefix: ["git", "blame"] },
  { name: "git-stash-list", prefix: ["git", "stash", "list"] },
];

/**
 * Guard: cancels the allowlist. Matched against the whole resource string because a redirection is
 * part of the resource, never a separate field.
 */
export type GuardRule =
  | { readonly name: string; readonly kind: "substring"; readonly value: string; readonly program?: string }
  | { readonly name: string; readonly kind: "token"; readonly values: readonly string[]; readonly program?: string }
  | { readonly name: string; readonly kind: "short-flag"; readonly value: string; readonly program?: string }
  /** Any token of a short cluster (`-10f`, `-1F`) contains one of the letters. */
  | { readonly name: string; readonly kind: "short-cluster"; readonly values: readonly string[]; readonly program?: string }
  | { readonly name: string; readonly kind: "long-flag"; readonly value: string; readonly program?: string }
  | { readonly name: string; readonly kind: "metacharacter"; readonly values: readonly string[] }
  /** The program is invoked through a path outside the trusted system directories. */
  | { readonly name: string; readonly kind: "program-path" }
  /** A positional operand resolves outside the working directory. */
  | { readonly name: string; readonly kind: "outside-cwd" }
  /** A search flag that turns off ignore files, hidden-file skipping or binary detection. */
  | { readonly name: string; readonly kind: "unrestricted-search"; readonly program?: string }
  /** A recursive search rooted at the working directory itself: the root guard never sees `.env`. */
  | { readonly name: string; readonly kind: "cwd-root-search"; readonly program?: string }
  /** `find -exec PROG`: every spawned program must be read-only and resolved through a trusted path. */
  | { readonly name: string; readonly kind: "find-exec"; readonly program?: string }
  /** Matched against text the shell would still act on: quoted literals do not count. */
  | { readonly name: string; readonly kind: "active-substring"; readonly value: string };

/**
 * Directories whose contents are installed by the system or the package manager. A program reached
 * through any other path may be a local shim that happens to share a read-only command's name.
 *
 * Defined in `shell.ts` because `find -exec` validates its spawned program against the same list and
 * `find.ts` must not import the rule table.
 */
export { TRUSTED_PROGRAM_DIRECTORIES } from "./shell.ts";

/**
 * Order is the rule contract: the first match wins and its name lands in the audit log. Specific
 * guards stay ahead of the catch-all `shell-metacharacter`, so `echo > x` keeps reporting `redirect`
 * and `$(...)` keeps reporting `shell-substitution`.
 */
export const GUARD_RULES: readonly GuardRule[] = [
  // Secrets a read-only command could otherwise print.
  { name: "secret-env", kind: "substring", value: ".env" },
  { name: "secret-ssh", kind: "substring", value: ".ssh" },
  { name: "secret-id-rsa", kind: "substring", value: "id_rsa" },
  { name: "secret-credentials", kind: "substring", value: "credentials" },
  { name: "system-etc", kind: "substring", value: "/etc/" },
  { name: "secret-netrc", kind: "substring", value: ".netrc" },
  { name: "secret-npmrc", kind: "substring", value: ".npmrc" },
  { name: "secret-yarnrc", kind: "substring", value: ".yarnrc" },
  { name: "secret-pgpass", kind: "substring", value: ".pgpass" },
  { name: "secret-git-credentials", kind: "substring", value: ".git-credentials" },
  { name: "secret-docker-config", kind: "substring", value: ".docker/config.json" },
  { name: "secret-kube-config", kind: "substring", value: ".kube/config" },
  { name: "secret-aws", kind: "substring", value: ".aws/" },
  { name: "secret-azure", kind: "substring", value: ".azure/" },
  { name: "secret-gcloud", kind: "substring", value: ".config/gcloud" },
  { name: "secret-gh", kind: "substring", value: ".config/gh" },
  { name: "secret-zsh-history", kind: "substring", value: ".zsh_history" },
  { name: "secret-bash-history", kind: "substring", value: ".bash_history" },
  { name: "secret-gitconfig", kind: "substring", value: ".gitconfig" },
  { name: "secret-id-ed25519", kind: "substring", value: "id_ed25519" },
  { name: "secret-id-ecdsa", kind: "substring", value: "id_ecdsa" },
  { name: "secret-pem", kind: "substring", value: ".pem" },
  { name: "system-proc", kind: "substring", value: "/proc/" },
  { name: "secret-generic", kind: "substring", value: "secrets" },
  { name: "secret-gnupg", kind: "substring", value: ".gnupg" },
  { name: "secret-password-store", kind: "substring", value: ".password-store" },
  { name: "secret-vault-token", kind: "substring", value: ".vault-token" },
  { name: "secret-opencode-auth", kind: "substring", value: ".local/share/opencode" },
  { name: "secret-opencode-config", kind: "substring", value: ".config/opencode" },
  // Case-insensitive comparison on the resource side, so the value is lowercase.
  { name: "secret-keychain", kind: "substring", value: "library/keychains" },
  { name: "secret-solana", kind: "substring", value: ".config/solana" },
  { name: "secret-git-config", kind: "substring", value: ".git/" },
  { name: "secret-p12", kind: "substring", value: ".p12" },
  // `.key` is the extension, not the word: `monkey` and `keyboard` carry no dot and stay allowed.
  { name: "secret-private-key", kind: "substring", value: ".key" },
  // Unbounded reads: never finish, or block on a terminal that will not close.
  { name: "endless-read", kind: "substring", value: "/dev/urandom" },
  { name: "endless-read", kind: "substring", value: "/dev/random" },
  { name: "endless-read", kind: "substring", value: "/dev/zero" },
  { name: "endless-read", kind: "substring", value: "/dev/stdin" },
  { name: "endless-read", kind: "substring", value: "/dev/fd/" },
  { name: "stdin-read", kind: "token", values: ["-"] },
  // `jq -n env` and `jq -n 'env.HOME'` print the whole environment without touching a file.
  { name: "jq-environment", kind: "substring", value: "env", program: "jq" },

  // Any write: `>` also covers `>>`, `2>` and `&>`.
  { name: "redirect", kind: "active-substring", value: ">" },
  { name: "tee", kind: "token", values: ["tee"] },
  // `-o` is an output flag only for git. For `find` it is the OR operator, for `grep`/`rg` it means
  // "only matching"; no allowlisted program writes through it.
  { name: "output-short-flag", kind: "short-flag", value: "-o", program: "git" },
  { name: "output-long-flag", kind: "long-flag", value: "--output" },

  // Executors hidden inside "read-only" tooling.
  { name: "rg-preprocessor", kind: "long-flag", value: "--pre" },
  { name: "rg-preprocessor", kind: "long-flag", value: "--pre-glob" },

  // Git "reads" that run a program configured in `.git/config` or `.gitattributes`.
  { name: "git-external-command", kind: "long-flag", value: "--ext-diff" },
  { name: "git-external-command", kind: "long-flag", value: "--textconv" },
  { name: "git-external-command", kind: "long-flag", value: "--show-signature" },

  // Flags that read a file the positional guard never sees.
  // `-f` is absent for `grep`/`rg`: it only loads patterns. `jq -f` runs a jq program that can print
  // `env`, so jq gets its own program-scoped guard below.
  { name: "file-read-flag", kind: "long-flag", value: "--contents" },
  { name: "file-read-flag", kind: "long-flag", value: "--slurpfile" },
  { name: "file-read-flag", kind: "long-flag", value: "--rawfile" },
  { name: "file-read-flag", kind: "long-flag", value: "--from-file" },
  { name: "jq-program-file", kind: "short-flag", value: "-f", program: "jq" },

  // Commands that change state while looking like reads.
  { name: "set-clock", kind: "short-flag", value: "-s", program: "date" },
  { name: "set-clock", kind: "long-flag", value: "--set", program: "date" },
  // `tail -1f`, `-10F` and `-f` all follow: the letter hides inside a numeric cluster.
  { name: "tail-follow", kind: "short-cluster", values: ["f", "F"], program: "tail" },
  { name: "tail-follow", kind: "long-flag", value: "--follow", program: "tail" },
  // `file -C` compiles the magic database into `magic.mgc` in the current directory.
  { name: "file-compile", kind: "short-flag", value: "-C", program: "file" },
  { name: "file-compile", kind: "long-flag", value: "--compile", program: "file" },

  // A program reached through a local or untrusted path can be a shim with a harmless basename.
  { name: "untrusted-binary", kind: "program-path" },

  // A scanner that failed to split leaves chaining inside one resource; never allow that.
  { name: "shell-operator", kind: "token", values: [";", "&", "&&", "|", "||", "`"] },
  { name: "shell-substitution", kind: "active-substring", value: "$(" },
  // Backticks are the other substitution form. Matched as a substring: the tokenizer glues a backtick
  // to the command it wraps, so the token rule above never sees a bare one.
  { name: "shell-backtick", kind: "active-substring", value: "`" },

  // Reads must stay inside the working directory: the read permission policy never sees a shell
  // command, so an allow here would hand the agent every file the user can read.
  { name: "outside-cwd", kind: "outside-cwd" },

  // Recursive search reads files whose names are not in argv, so the path guard cannot see them.
  // Plain `rg` skips hidden files and honours ignore files; the flags below turn that off.
  { name: "rg-unrestricted", kind: "unrestricted-search", program: "rg" },
  // GNU/BSD grep has no ignore files at all: `grep -r . .` reads `.env` by construction. Recursion
  // is allowed only when its root is narrower than the working directory itself.
  { name: "recursive-search", kind: "cwd-root-search", program: "grep" },

  // `find . -delete` writes, `find . -exec sh -c '...'` runs code, `-execdir`/`-ok` bypass the exec
  // validation. The exec guard then allows only read-only programs behind a trusted path.
  { name: "find-write", kind: "token", values: FIND_WRITE_PREDICATES, program: "find" },
  { name: "find-exec", kind: "find-exec", program: "find" },

  // Catch-all for anything else the shell would interpret: `;`, newlines, `&`, `<`, parentheses,
  // braces, backslashes, history expansion, globs and bracket expressions. Checked on the raw resource
  // before tokenization, because tokenizing glues `;` to the preceding word. Deliberately noisy:
  // `rg "a|b"` asks. A false ask costs one keypress, a false allow costs a shell.
  // `%x` is git's hex-escape form and can emit an ESC byte; the literal ESC covers printf and echo.
  {
    name: "shell-metacharacter",
    kind: "metacharacter",
    values: [
      ";",
      "\n",
      "\r",
      "&",
      "|",
      "`",
      "$",
      "(",
      ")",
      "{",
      "}",
      "<",
      ">",
      "\\",
      "!",
      "*",
      "?",
      "[",
      "]",
      "%x",
      "\u001b",
    ],
  },
];

Reuse an existing terminal whenever possible. Never run a standalone `cd` command; combine the working-directory change and command in one invocation. Do not start long-running foreground servers in Cline terminals. Ask before starting any persistent process.

Use application source files and example configuration when investigating the project. Do not seek live credentials, secret values, generated artifacts, or private data.

If any tool operation is denied by workspace policy, treat that operation and path as unavailable. Do not retry it, investigate the policy, or attempt an
alternative access method. Continue using available source files, or ask the user if the unavailable information is essential.


Environment configuration files are protected. Infer variable names from `.env.example` and source code. If live values are required, ask the user to run a narrowly scoped command or provide a sanitized result.

Do not reference or attempt to edit the following files, paths, or globs in terminal commands:

```
node_modules/
**/node_modules/

dist/
build/
.next/
out/
coverage/
.cache/
.turbo/

*.map
*.min.js
*.log

.clineignore
.env
.env.*
!.env.example

*.sqlite
*.db
*.csv

package-lock.json
pnpm-lock.yaml
yarn.lock
```

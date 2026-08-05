# Oracle Cloud Always Free deployment runbook

Everything scriptable is scripted (`deploy/setup.sh`, `deploy/Caddyfile`).
This lists exactly what's left — the parts only you can do.

## 0. Prerequisite: this repo needs a git remote

`deploy/setup.sh` clones the app from a git URL, and this working directory
isn't a git repo yet — there's nothing for the VM to clone from. Before
anything else:

```
git init
git add .
git commit -m "initial commit"
```

Then create an empty repository somewhere reachable from the VM (a private
GitHub repo is the easy default) and push:

```
git remote add origin <your-repo-url>
git push -u origin main
```

If the repo is private, the VM will need a way to authenticate the clone —
either an SSH deploy key (generate one on the VM, add the public half to
the GitHub repo's deploy keys) or a personal access token in the HTTPS URL.
A public repo sidesteps this entirely if the code has nothing sensitive in
it (it doesn't — all real secrets live in `.env`, which is gitignored).

## 1. Create the Oracle account + instance

- Sign up at oracle.com/cloud/free (requires a credit card for identity
  verification, but the Always Free resources genuinely never bill —
  distinct from the 30-day trial credit).
- Create a Compute instance:
  - **Shape: Ampere A1 (ARM), 4 OCPU / 24GB RAM** — Always Free covers a
    full A1 instance at this size, and it's a large multiple of what this
    app actually needs (SQLite, no heavy compute, occasional CLI calls to
    `claude`). The alternative free shape (AMD Micro, 1/8 OCPU / 1GB RAM
    ×2) works too but is tighter for no benefit — take the A1.
  - **Image: Ubuntu 22.04 or 24.04 LTS** — what `deploy/setup.sh` assumes
    (NodeSource's apt repo, Caddy's apt repo).
  - Generate/upload an SSH key pair during creation — you'll need it to
    SSH in.
  - Note the instance's public IP once it's running.

## 2. Open the firewall — two layers, both required

Oracle instances sit behind **two** independent firewalls; opening only one
is the most common reason "it worked on localhost but not from outside"
happens.

**a. VCN security list** (Oracle's console, not the VM itself):
Networking → Virtual Cloud Networks → your VCN → Security Lists → default
security list → Add Ingress Rules:
- Source CIDR `0.0.0.0/0`, TCP, destination port `80`
- Source CIDR `0.0.0.0/0`, TCP, destination port `443`
(Port 22/SSH is normally open by default in the default security list —
confirm it's there before you rely on it.)

**b. The instance's own OS firewall — read this before just running `ufw
allow`.** Oracle's stock Ubuntu images ship with a pre-populated `iptables`
ruleset that runs independently of `ufw` — by default it explicitly
`ACCEPT`s port 22 and rejects everything else, configured outside of ufw's
control. `ufw allow 80/tcp` reporting success and `ufw status` showing it
as allowed does **not** mean it's actually being enforced — confirmed
during this app's own deployment: every other layer (security list, NSGs,
DNS, the app itself listening correctly) checked out clean while 80/443
stayed closed from outside, and this was the actual cause. Symptom to
recognize: SSH (22) works externally, 80/443 don't, despite ufw agreeing
they should.

Check which ruleset is actually active first:
```
sudo iptables -L INPUT -n --line-numbers
```
Look for a `REJECT`/`DROP` rule with a lower line number (= higher
precedence) than any 80/443 rule. If that command shows nothing useful,
newer Ubuntu (22.04/24.04) may be running `iptables` as an nftables-compat
shim — check the real legacy ruleset instead:
```
sudo iptables-legacy -L INPUT -n --line-numbers
```

Fix — insert ahead of the reject rule (appending after it gets ignored),
using whichever of `iptables`/`iptables-legacy` showed the real ruleset
above:
```
sudo iptables -I INPUT -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```
If you needed `iptables-legacy` to see the real rules, use it here too,
and persist with `sudo iptables-legacy-save | sudo tee
/etc/iptables/rules.v4` instead of `netfilter-persistent save` — this
persistence step matters as much as the rule itself; `ufw`'s own
persistence doesn't cover this separate ruleset.

Only bother with plain `ufw allow 22/80/443/tcp` / `ufw enable` if the
check above shows ufw genuinely is the active enforcement layer (no
competing iptables ruleset found) — don't run both blindly.

## 3. Sign up for a free DuckDNS subdomain

No domain purchase needed — duckdns.org gives free subdomains
(`whatever-you-pick.duckdns.org`) for exactly this kind of use.

- Go to duckdns.org, sign in (GitHub/Google/etc.), pick a subdomain name.
- Copy the token shown on your DuckDNS account page.
- You don't need to point it at the instance's IP by hand — the setup
  script's DuckDNS step does that (and keeps it updated) once you pass
  both values in, in step 4.

## 4. SSH in and run the setup script

From your own machine:
```
scp deploy/setup.sh ubuntu@<instance-ip>:~/
ssh ubuntu@<instance-ip>
```
On the instance:
```
chmod +x setup.sh
sudo REPO_URL="<your-repo-url-from-step-0>" \
     DUCKDNS_SUBDOMAIN="<name-from-step-3>" \
     DUCKDNS_TOKEN="<token-from-step-3>" \
     ./setup.sh
```
This installs Node, the `claude` CLI, clones the app, builds it, runs
migrations, points your DuckDNS subdomain at this instance and sets up a
cron job to keep it that way, and creates the systemd unit plus
`/etc/sports-edge/sports-edge.env` with placeholders — then stops short of
starting the service, because two things still need your hands:

## 5. Fill in real secrets

```
sudo nano /etc/sports-edge/sports-edge.env
```
Replace every `REPLACE_ME`:
- `AUTH_SHARED_SECRET` — pick a long random value (e.g. `openssl rand -hex
  32`). This is what you'll type as the password in your browser's Basic
  Auth prompt.
- `THE_ODDS_API_KEY` — the **freshly rotated** key, not the one exposed in
  this machine's local session transcripts during the 2026-08 audit.
- The remaining provider keys (`NEWSAPI_KEY`, `API_FOOTBALL_KEY`,
  `SPORTMONKS_API_KEY`, `FOOTBALL_DATA_API_KEY`, `OPENWEATHERMAP_API_KEY`,
  `SOFASCORE_RAPIDAPI_KEY`) — copy from your existing `.env`.

## 6. Log the `claude` CLI in

This app authenticates to Anthropic via the CLI's own subscription login,
deliberately not an API key (see `src/agents/ClaudeCodeAgent.ts`'s header
comment — it strips `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from its own
subprocess env on purpose). That login is interactive and can't be
scripted. As the `sports-edge` user on the instance:
```
sudo -u sports-edge claude /login
```
Follow its prompts — if it gives you a URL to visit, open that on your own
device, not the headless VM. Confirm it worked:
```
sudo -u sports-edge claude -p "say hi" --output-format json
```

## 7. Start the service

```
sudo systemctl start sports-edge
sudo systemctl status sports-edge
journalctl -u sports-edge -f    # tail logs
```

## 8. Set up Caddy

```
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | \
  sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | \
  sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```
Your DuckDNS subdomain from step 3 is already pointing at this instance
(the setup script handled that). Edit `deploy/Caddyfile`, replace
`your-chosen-name.duckdns.org` in the block header with the actual name you
picked, then create the log directory Caddyfile's `log` block writes to —
the apt package creates a `caddy` system user/group and runs the service
as that user, but does NOT create `/var/log/caddy` for you; skip this and
the reload below fails with a permission-denied error trying to create it:
```
sudo mkdir -p /var/log/caddy
sudo chown caddy:caddy /var/log/caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```
Caddy will request a Let's Encrypt certificate for that subdomain
automatically on first request — no separate certbot step.

## 9. Verify

Visit `https://your-chosen-name.duckdns.org`. You should get a browser Basic Auth prompt
before seeing anything — any username, `AUTH_SHARED_SECRET`'s value as the
password. If the dashboard loads and fixtures show up, you're done.

## Redeploying later

Re-running `deploy/setup.sh` (same `REPO_URL`) on the instance pulls the
latest code, rebuilds, re-migrates, and restarts the service — the same
script handles both first-time setup and every update after that. The
DUCKDNS_* vars aren't needed on redeploys — the cron job from step 4
already keeps DNS updated independently of this script running again.

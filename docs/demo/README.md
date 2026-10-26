# Demo

`demo.sh` shows the idea in about ten seconds without any account: one endpoint, two accounts, a separate worker process per account (different `pid`; the default account runs without the profile variable, hence `profile=null`), and `requireAccount` refusing a call that names none.

~~~sh
sh docs/demo/demo.sh
~~~

## Re-rendering the README GIF

`demo.gif` is rendered from the real output of `demo.sh` (only the typing is animated). Needs Python with Pillow:

~~~sh
python3 -I docs/demo/make-gif.py
~~~

## The two-Google-accounts version

With real accounts (`acctmux init --preset google-workspace`, one `google-workspace-mcp auth --profile personal` per extra account), ask your client: "how much Drive space is left on my work and personal accounts?". It calls `get_storage_quota` with `account=work` and `account=personal` in one turn. Record that session with the same tools; blur anything with an email address.

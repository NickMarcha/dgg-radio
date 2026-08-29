# Production deployment

How the running deployment is put together, and what happens when you push to `main`. [The README's Deployment section](../README.md#deployment) covers how to configure a stack from scratch; this describes the one that exists.

## Shape

Two halves, deployed independently from the same repository.

| | Frontend | API |
|---|---|---|
| What | The static Astro site | Hono server, Postgres, and a Cloudflare tunnel as one Docker Compose stack |
| Where | Netlify | A private always-on server |
| Built by | Netlify's own builders | The deployment host, from source |
| Reached at | The Netlify site origin | A Cloudflare tunnel hostname |

The API is not on Netlify because it holds WebSocket connections and runs the playback clock, neither of which survive a function invocation model.

The API server is not publicly addressable and opens no inbound ports. Everything reaches it through the Cloudflare tunnel, which the stack dials outward. That also means the host can sit behind CGNAT or a residential connection with no port forwarding, and that Cloudflare's DDoS protection and WAF sit in front of the API rather than it being exposed directly.

## What a push to `main` does

Both pipelines trigger independently and finish within about a minute of each other.

**Frontend.** The Netlify site is linked to the repository, so a push starts a build. Netlify runs `npm run build:web` and publishes `dist`, per `netlify.toml`.

`PUBLIC_API_URL` is read at **build time**, so it must be set in Netlify's environment variables, not just in a local `.env`. A local `.env` only affects local builds; if the variable is missing on Netlify the deployed site is built pointing at nothing. The same applies to `PUBLIC_POSTHOG_KEY` and `PUBLIC_POSTHOG_HOST` — absent there, the deployed site silently reports no browser analytics even though local builds do.

**API.** A GitHub webhook on the repository calls the deployment platform, which clones the commit, rebuilds the image, and recreates the stack. Docker only replaces containers whose image or configuration actually changed, so a docs-only commit deploys without restarting anything.

Migrations are not a separate step. The API applies pending migrations as it starts and refuses to serve if they fail, because nobody is present at deploy time to run them by hand.

## The two settings that make it work

**`webhook_force_deploy` must be on.** Without it a push runs `DeployStackIfChanged`, which compares the *contents of `compose.yaml`* between what is deployed and what is in git. This stack builds the API from source, so changes to `server/` or `src/` leave `compose.yaml` byte-identical and nothing deploys — silently, since finding no change is not an error. The default suits stacks that pull published images; it is wrong for one that builds.

**The deployment platform must be able to read `compose.yaml`.** If it cannot, the change comparison sees no remote contents and takes a branch that deploys nothing — the same silence, a different cause.

## Verifying a deploy actually happened

Comparing the deployed commit against the latest commit is the quick check. To confirm *what* triggered a deploy, look at the operator on the deploy record: webhook-triggered deploys are attributed to the platform's synthetic git-webhook user, manual ones to whichever API key or account ran them. That distinction is the only reliable way to tell an automatic deploy from someone having pressed the button.

A push that changes only documentation is **not** a valid test of the webhook. It proves the trigger fired but cannot prove a rebuild, and under the default `webhook_force_deploy` it proves nothing at all.

## Trying a change before it deploys

Nothing about this deployment has a staging half, and a push to `main` is a deploy. The same stack runs locally instead: `npm run stack:test` builds the same image from the working tree and starts it against the local Postgres, with the tunnel parked and the API published on the host. It is the only way to see a server change run the way production will run it before `main` has it. The README's [test environment](../README.md#test-environment) has the details.

## Manual fallback

The stack can be deployed on demand from the deployment platform's UI or API. Doing so is safe at any time and is the fastest way to recover if a webhook delivery is missed — the git clone is re-pulled either way, so a manual deploy lands the same commit the webhook would have.

## Changing the API hostname

Three things must move together, and a stale one fails quietly rather than loudly:

1. The tunnel's public hostname route, which points at `http://api:8787` over the Compose network.
2. `PUBLIC_API_URL` in Netlify's environment — followed by a **rebuild**, since it is baked in at build time.
3. Nothing on the Destiny side. `DGG_REDIRECT_URI` is a frontend route, so the API can move hosts without re-registering the OAuth application.

`APP_ORIGIN` on the API is the *frontend* origin, not the API's own, and only changes if the site moves.

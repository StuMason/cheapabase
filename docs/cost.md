# What does it cost on Railway?

Short version: **a small app fits inside Railway's $5/month Hobby plan.** A busy one (20 requests a
second around the clock, 100 live realtime connections) works out to roughly **$11/month**.

These are estimates from measured resource use, not a quote. Railway bills for what your services
actually use, so check the usage page in your Railway project for real numbers.

## Railway prices used

From [Railway's pricing page](https://docs.railway.com/reference/pricing/plans), checked October 2026:

| Resource | Price |
|---|---|
| RAM | $10 per GB per month |
| CPU | $20 per vCPU per month |
| Volume storage (the Postgres disk) | $0.15 per GB per month |
| Network egress | $0.05 per GB |
| Hobby plan | $5/month, includes $5 of usage |
| Trial | one-time $5 credit |

## What we measured

Local Docker (`docker stats`), `postgres:16-alpine` + the cheapabase image:

| | cheapabase app | Postgres |
|---|---|---|
| Idle | ~40MB RAM, ~0% CPU | ~60MB RAM, ~0% CPU |
| Load: 100 realtime sockets, 20 req/s (half writes) | ~95MB RAM, ~0.18 vCPU | ~100MB RAM, ~0.19 vCPU |

The load run handled 800 requests with 0 failures and delivered 2,000 RLS-checked realtime events.
Reproduce it yourself:

```bash
docker compose up -d
bun run loadtest 40 20     # 40 seconds at 20 requests/second
docker stats               # in another terminal
```

## Estimates

**Side project or demo** (mostly idle, a few users):

| | Monthly |
|---|---|
| RAM: 0.1GB × $10 | $1.00 |
| CPU: ~0.01 vCPU × $20 | $0.20 |
| Postgres volume: 1GB × $0.15 | $0.15 |
| Egress: 1GB × $0.05 | $0.05 |
| **Usage** | **~$1.40**, covered by the Hobby plan's included $5 |
| **You pay** | **$5/month** (the Hobby plan) |

**Busy app** (20 requests/second 24/7, about 52 million requests a month, 100 live connections):

| | Monthly |
|---|---|
| RAM: ~0.2GB × $10 | $2.00 |
| CPU: ~0.37 vCPU × $20 | $7.40 |
| Postgres volume: 5GB × $0.15 | $0.75 |
| Egress: 20GB × $0.05 | $1.00 |
| **You pay** | **~$11/month** |

## Compared to self-hosting full Supabase

Supabase's [self-hosting guide](https://supabase.com/docs/guides/self-hosting/docker) lists a minimum
of **4GB RAM and 2 CPU cores** for all components. At Railway's RAM price, 4GB is $40/month before
any CPU. Even if you trim services, the full stack is roughly 10-20x the memory of cheapabase, and on
usage-based hosting memory is most of the bill.

## Keeping it cheap

- One replica is plenty for most apps. Each extra replica adds its RAM to the bill.
- Railway can sleep services with no traffic (serverless / app sleeping). Fine for demos; the first
  request after sleeping is slow while auth, PostgREST and migrations start.
- Most of the busy-app cost is CPU from realtime RLS checks and writes. If you don't need realtime on
  a table, don't `realtime.enable()` it.

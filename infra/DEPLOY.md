# Deploying a hub

This puts a promptd hub on the internet, so nodes on any network can reach it:

- **The host.** One ARM EC2 instance runs the hub in Docker behind Caddy, which gets and renews the HTTPS certificate.
- **The data.** The SQLite database and every run log live on their own EBS volume, snapshotted daily.
- **Shipping.** `scripts/deploy-hub.sh` builds the image, stores it in ECR, and restarts the hub on it.

Nodes stay where they are. Each one polls the hub over HTTPS and needs only outbound access.

Everything below is yours to fill in. `promptd.example.com`, `promptd-admin` and the other sample values are placeholders.

## What you need

1. An AWS account, and an AWS CLI profile with admin rights on it. The examples call it `promptd-admin`.
2. A host name whose DNS you control, such as `promptd.example.com`. The steps show Cloudflare; any DNS provider works.
3. On your machine: Terraform 1.5 or newer, Docker with `buildx`, the AWS CLI, Node 20 or newer, and a checkout with `npm install` done.

## 1. Create the Terraform state bucket

```sh
cd infra/bootstrap
terraform init
terraform apply -var aws_profile=promptd-admin
```

Note the `state_bucket` and `lock_table` outputs.

## 2. Create the hub

```sh
cd ../terraform
cp example.tfvars terraform.tfvars   # then fill in your values
terraform init \
  -backend-config="bucket=<state_bucket>" \
  -backend-config="dynamodb_table=<lock_table>" \
  -backend-config="region=us-east-1" \
  -backend-config="profile=promptd-admin"
terraform plan -out=tfplan
terraform apply tfplan
```

`terraform.tfvars` is git-ignored, and so is the state, which lives in your bucket.

The instance boots while this runs. Its first attempt to start the hub fails because there is no image yet; step 5 fixes that.

## 3. Store the secrets

Terraform created empty slots under `/promptd/prod` in SSM Parameter Store. Fill them. Use the `ssm_prefix` output if you changed `name`.

```sh
PREFIX=/promptd/prod
PROFILE=promptd-admin

# The web page's admin password. This prompts for it and prints only a hash.
HASH=$(npm run -s set-password -- --print-hash)
aws --profile $PROFILE ssm put-parameter --overwrite --type SecureString \
  --name $PREFIX/PROMPTD_ADMIN_PASSWORD_HASH --value "$HASH"

aws --profile $PROFILE ssm put-parameter --overwrite --type SecureString \
  --name $PREFIX/SESSION_SECRET --value "$(openssl rand -hex 32)"

# The token every node presents. Keep a copy: each node needs it.
NODE_TOKEN=$(openssl rand -hex 32)
aws --profile $PROFILE ssm put-parameter --overwrite --type SecureString \
  --name $PREFIX/PROMPTD_NODE_TOKEN --value "$NODE_TOKEN"
```

The hub refuses to start without an admin password, so this step has to come before the first deploy.

To use Postgres instead of the SQLite file on the data volume, also add a `DATABASE_URL` parameter holding a `postgres://` address.

## 4. Point your DNS at the hub

There are two ways. Pick one with `manage_dns` in `terraform.tfvars`.

**Route 53 (`manage_dns = true`).** Terraform creates a hosted zone for your host name and its A record, and the name is handed to that zone. This costs $0.50 a month for the zone.

```sh
terraform output hub_nameservers
```

At your parent domain's DNS, add four `NS` records for the host (for example `promptd`), one for each nameserver. In Cloudflare, that's DNS → Records → Add record → type `NS`. Cloudflare won't allow an `NS` and an `A` record on the same name, so delete any existing `A` record in the same edit.

**Your own DNS (`manage_dns = false`, the default).** Add one `A` record yourself:

```sh
terraform output hub_ip
```

In Cloudflare, add an `A` record under DNS → Records:

- **Name:** your host, for example `promptd`
- **IPv4 address:** the `hub_ip` output
- **Proxy status:** DNS only, the grey cloud

Leave the proxy off. With it on, Caddy can't get its certificate, and the page loops on redirects. A proxy in between can also hold back the live log and event streams.

Either way, the address is an Elastic IP. It stays the same across deploys, and even when Terraform replaces the instance, so DNS is set once.

## 5. Ship the first version

```sh
cd ../..
./scripts/deploy-hub.sh
```

The script reads everything it needs from the Terraform outputs:

1. It builds this commit as an ARM64 image and pushes it to ECR, tagged with the commit.
2. It sets the `IMAGE_TAG` parameter to that tag.
3. It runs `deploy.sh` on the host over SSM, which fetches the secrets, pulls the image and restarts the hub.
4. It waits until `/api/health` answers.

Run the same command whenever you want to ship a new version. A checkout with uncommitted changes still deploys, with the tag marked `-dirty`.

## 6. Sign in

Open `https://promptd.example.com` (your host) and sign in with the password from step 3. The first visit can take a minute while Caddy gets the certificate. If Caddy started before your DNS was in place, it retries on a backoff that can stretch to hours; `sudo systemctl restart caddy` on the host makes it try again straight away.

To look around on the host:

```sh
INSTANCE_ID=$(terraform -chdir=infra/terraform output -raw hub_instance_id)
aws --profile promptd-admin ssm start-session --target "$INSTANCE_ID"
sudo docker compose -f /opt/promptd/docker-compose.yml ps
sudo docker compose -f /opt/promptd/docker-compose.yml logs --tail 50
sudo journalctl -u caddy --no-pager -n 50
```

Replace `promptd` in the path if you changed `name`.

## 7. Connect nodes

On each Mac that should run jobs, in a checkout of this repository:

```sh
NODE_ONLY=1 HUB_URL=https://promptd.example.com NODE_TOKEN=<token from step 3> \
  ./scripts/register-app-mac-os.sh
```

The first node to connect becomes the default node, which runs every job with no node of its own. The hosted hub does not run jobs itself.

A Mac that already runs a full local install has a node agent of its own. There are two ways to go from there:

1. **Keep the local hub, and add a second node.** Give the new node its own id and launchd label, so it doesn't collide with the local one:

   ```sh
   NODE_ONLY=1 HUB_URL=https://promptd.example.com NODE_TOKEN=<token> \
     NODE_ID=<this-mac>-hosted NODE_LABEL=local.promptd.hosted-node ./scripts/register-app-mac-os.sh
   ```

2. **Move to the hosted hub.** That Mac's jobs stay in its local hub and are not copied across, so recreate them on the hosted one. Stop the local hub with `launchctl bootout gui/$(id -u)/local.promptd`, then register as above with `FORCE=1`, so the new node replaces the old node agent.

## Rolling back

```sh
./scripts/deploy-hub.sh --tag <earlier tag>
```

That skips the build and deploys an image already in ECR. ECR keeps the 10 most recent tagged images; `aws ecr describe-images --repository-name promptd-hub` lists them.

## Changing a secret

Write the new value with `aws ssm put-parameter --overwrite` as in step 3, then run `./scripts/deploy-hub.sh --tag <current tag>` to restart the hub on it. The hub reads its secrets from SSM on every deploy.

- **A new admin password** signs every session out.
- **A new `SESSION_SECRET`** does the same.
- **A new node token** means every node needs it too. Re-register each node with `FORCE=1` and the new `NODE_TOKEN`.

## Restoring from a backup

The data volume is snapshotted daily at 07:00 UTC and each snapshot is kept for 14 days (`backup_retention_days`).

1. In the AWS Backup console, restore a recovery point to a new EBS volume in the same availability zone.
2. Stop the instance and detach the current `promptd-data` volume.
3. Attach the restored volume as `/dev/sdf`, then start the instance. It mounts by filesystem label, which the restore keeps.

## Tearing it down

`terraform destroy` removes everything except the data volume, which is protected so a refactor cannot delete your jobs and logs. To delete it as well, remove `prevent_destroy` from `compute.tf` first.

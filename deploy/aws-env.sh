# The deployed stack's coordinates. Source this before the deploy scripts:
#
#     source deploy/aws-env.sh
#
# None of these are secrets — they are public URLs and resource ids, and
# they are useless without AWS credentials or the SSH key. The two things
# that ARE secret live elsewhere on purpose: the SSH key at
# ~/.ssh/silla-deploy.pem, and the application secrets in /etc/silla/*.env
# on the box itself.

export AWS_REGION=ap-southeast-1

# ---- the box ----
export SILLA_HOST=13.251.74.151                 # Elastic IP, stable across reboots
export SILLA_SSH_KEY="$HOME/.ssh/silla-deploy.pem"
export SILLA_INSTANCE=i-03965ef2bfef96606
export SILLA_SG=sg-03be50d24f6d69c1c

# ---- what the browser hits ----
export API_URL=https://d7w5zy7mzwali.cloudfront.net
export VENDOR_API_URL=https://d7w5zy7mzwali.cloudfront.net   # nginx routes /api/vendor/* to :4100
export CLIENT_URL=https://d3ttts3ghharsa.cloudfront.net
export PORTAL_URL=https://d3jtrqcm6l2crg.cloudfront.net

# ---- static hosting ----
export CLIENT_BUCKET=silla-client-204603
export PORTAL_BUCKET=silla-portal-204603
export CLIENT_DIST_ID=ERWHO88XIMD9H
export PORTAL_DIST_ID=E1TF02WVIQ8GQL
export API_DIST_ID=EW97K1LVLRDL9

# Baked into the client bundle at BUILD time, so it must be right before
# you build, not after. See deploy/README.md.
export DEMO_ORG_ID=6a8ed2b8587f249ffe338781

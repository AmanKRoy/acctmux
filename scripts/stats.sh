#!/bin/sh
# Real adoption numbers for acctmux: npm downloads, GitHub stars/forks, 14-day traffic.
set -e
R=AmanKRoy/acctmux
echo "npm last-week:  $(curl -s https://api.npmjs.org/downloads/point/last-week/acctmux | grep -o '"downloads":[0-9]*')"
echo "npm last-month: $(curl -s https://api.npmjs.org/downloads/point/last-month/acctmux | grep -o '"downloads":[0-9]*')"
gh api repos/$R --jq '"stars: \(.stargazers_count)  forks: \(.forks_count)  watchers: \(.subscribers_count)  open issues: \(.open_issues_count)"'
gh api repos/$R/traffic/views --jq '"views(14d): \(.count) unique: \(.uniques)"'
gh api repos/$R/traffic/clones --jq '"clones(14d): \(.count) unique: \(.uniques)"'
echo "top referrers:"; gh api repos/$R/traffic/popular/referrers --jq '.[]|"  \(.referrer): \(.count) (\(.uniques) unique)"'

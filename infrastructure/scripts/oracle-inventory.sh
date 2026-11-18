#!/usr/bin/env bash
# Read-only. Run as the usual deployment account on the Oracle host.
set -u
section() { printf '\n===== %s =====\n' "$1"; }
section "Host architecture and CPU"; uname -sm; nproc
section "Memory"; free -h
section "Disk"; df -h /
section "Docker"
if command -v docker >/dev/null; then
  docker --version
  docker compose version
  section "Containers and published ports"
  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  section "Compose projects"
  docker compose ls
else
  echo "Docker CLI unavailable"
fi
section "Listening TCP and UDP ports"
if command -v ss >/dev/null; then ss -lntu; else echo "ss unavailable"; fi
section "Disk usage under /home/ubuntu"
if [[ -r /home/ubuntu ]]; then
  du -sh /home/ubuntu/* 2>/dev/null | sort -h
else
  echo "/home/ubuntu unavailable to this account"
fi

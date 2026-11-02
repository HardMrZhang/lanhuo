#!/usr/bin/env bash
# EC2 首装脚本（Amazon Linux 2023，东京）：Node 22 + Nginx + 目录 + 自启
# 用法：把本文件 scp 到 EC2 后 sudo bash ec2-setup.sh
set -euo pipefail

dnf install -y nginx git rsync
systemctl enable --now nginx

# Node 22（Nodesource）
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs
node -v

# MySQL 8（会员库；已有 RDS 可跳过本段）
dnf install -y mysql-server || dnf install -y mariadb105-server || true
systemctl enable --now mysqld 2>/dev/null || systemctl enable --now mariadb 2>/dev/null || true

mkdir -p /opt/duanju-h5
chown ec2-user:ec2-user /opt/duanju-h5

# systemd 服务（deploy/duanju-h5.service 已随代码同步过来）
cp /opt/duanju-h5/deploy/duanju-h5.service /etc/systemd/system/duanju-h5.service
systemctl daemon-reload
systemctl enable duanju-h5

# 给 Node 开 3001（仅本机，公网只走 80/443）
# firewalld 默认不开，安全组里只放 80/443 + 你的 SSH IP 即可

echo "首装完成。下一步：本地 npm run build 后 rsync 到 /opt/duanju-h5，scp .env 上去，systemctl start duanju-h5"

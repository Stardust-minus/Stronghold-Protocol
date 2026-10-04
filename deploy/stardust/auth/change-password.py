#!/usr/bin/env python3
import getpass
import os
from pathlib import Path
import subprocess
import sys

if os.geteuid() != 0:
    sys.exit('请以 root 运行此工具。')
if not sys.stdin.isatty():
    sys.exit('请通过交互终端运行，避免把口令写入命令行或日志。')
password = getpass.getpass('新的访问口令（至少 6 个字符，建议 12 位以上随机口令）：')
if password != getpass.getpass('再次输入新口令：'):
    sys.exit('两次输入不一致，未做修改。')
if not 6 <= len(password) <= 256 or len(password.encode()) > 512:
    sys.exit('口令需为 6–256 个字符且不超过 512 个 UTF-8 字节，未做修改。')
if len(password) < 12 or password.isdigit():
    print('提示：较短或纯数字口令强度较低，建议后续使用更长的随机口令。')
source = Path(__file__).resolve().parent
subprocess.run(['node', str(source / 'set-password.mjs'), '/opt/ark-proto/auth-secrets/gate.json'], input=password + '\n', text=True, check=True)
subprocess.run(['docker', 'compose', '-p', 'ark-proto-auth', '-f', '/opt/ark-proto/compose.auth.yaml', 'up', '-d', '--force-recreate', '--wait', '--wait-timeout', '60', 'auth'], check=True)
print('访问口令已更新，旧登录 Cookie 已失效；游戏容器未重启。已建立的 WebSocket 不会被强制断开。')

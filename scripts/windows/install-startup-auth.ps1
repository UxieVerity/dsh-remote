# 装回 dsh-web-startup-auth（用户名/密码登录，不需要每次复制 token 地址）
# 用法：双击同目录下的 install-startup-auth.cmd
# 说明：本文件带 UTF-8 BOM，Windows PowerShell 5.1 才会按 UTF-8 读中文。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dsh = 'E:\deepseek\resources\runtime\cli\bin\dsh.cmd'

$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running) {
  Write-Host '检测到 DeepSeek Harness 还在运行。' -ForegroundColor Yellow
  Write-Host '请先完全退出它（托盘图标也要退干净），然后重新运行。' -ForegroundColor Yellow
  Write-Host ''
  Read-Host '按回车关闭'
  exit 1
}

Write-Host '== 安装 dsh-web-startup-auth@0.1.13 到 desktop profile ==' -ForegroundColor Cyan
& $dsh plugin --profile desktop add dsh-web-startup-auth@0.1.13
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '默认 registry 可能没有这个包，改用官方 registry 再试一次……' -ForegroundColor Yellow
  & $dsh plugin --profile desktop add dsh-web-startup-auth@0.1.13 --registry https://registry.npmjs.org/
}

Write-Host ''
Write-Host '== 已安装的插件 ==' -ForegroundColor Cyan
& $dsh plugin --profile desktop list

Write-Host ''
Write-Host '装好后启动 DeepSeek Harness：远程第一次访问会引导设置管理员账号密码，' -ForegroundColor Green
Write-Host '之后登录一次即可（会话 cookie 默认 14 天），不用再复制 token 地址。' -ForegroundColor Green
Read-Host '按回车关闭'
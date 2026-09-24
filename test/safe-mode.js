process.env.SAFE_MODE = 'true';
const { findBlockedPattern } = require('../serverModules/commandExecutor');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

const mustBlock = [
    'rm -rf /', 'rm -fr /', 'rm -f -r /', 'rm -r -f /', 'rm -Rf /', 'sudo rm -rf /',
    'rm -rf /*', 'rm -rf / *', 'rm -rf /;echo', 'rm -rf /$x', 'rm -rf /\nfoo',
    'rm --recursive --force /', 'rm --force --recursive / *', 'rm -rf --no-preserve-root /',
    'x=$(rm -rf /tmp/a)', 'echo `rm -rf /tmp/a`',
    'dd if=/dev/zero of=/dev/sda', 'dd if=/dev/zero of="/dev/sda"', "dd if=/dev/zero of='/dev/sda'", 'dd of=/dev/sda if=/dev/zero',
    ':(){ :|:& };:', 'bomb(){ bomb|bomb& };bomb',
    'mkfs.ext4 /dev/sdb1', 'shutdown -h now', 'reboot',
    'passwd', ' passwd', 'sudo passwd root', '(passwd)', 'x=$(passwd)', 'echo `passwd`', 'true;passwd'
];
const mustAllow = [
    'rm -rf /tmp/build', 'rm -rf build/', 'rm --recursive --force /tmp/build',
    'dd if=/dev/zero of=/tmp/disk.img', 'dd if=/dev/sda of=/tmp/mbr.bin bs=512 count=1',
    'dd if=/dev/zero of=/dev/null bs=1M count=10', 'dd if=/dev/zero of=/dev/shm/test bs=1M count=1',
    'cat /etc/passwd', 'grep root /etc/passwd', 'ls -la'
];

for (const command of mustBlock) assert(findBlockedPattern(command), 'SAFE_MODE blocks ' + JSON.stringify(command));
for (const command of mustAllow) assert(!findBlockedPattern(command), 'SAFE_MODE allows ' + JSON.stringify(command));

#!/usr/bin/perl
# Install the extension into Firefox via the Remote Debugging Protocol (RDP) -
# the same channel web-ext uses. Unlike Marionette, RDP does NOT set the
# navigator.webdriver "automation" flag, so sites won't throw robot-checks.
# Firefox must be launched with:  -start-debugger-server <port>
# and the profile must allow it (installer writes the prefs into user.js).
#
# Usage: perl rdp-install.pl [port] [path-to-extension-dir]
use strict;
use warnings;
use IO::Socket::INET;
use JSON::PP;
use File::Basename;
use Cwd qw(abs_path);

my $PORT = $ARGV[0] || 6000;
my $EXT  = $ARGV[1] || (dirname(dirname(abs_path($0))) . "/extension");
my $json = JSON::PP->new->utf8;

my $sock;
for (my $i = 0; $i < 80; $i++) {
    $sock = IO::Socket::INET->new(PeerAddr => '127.0.0.1', PeerPort => $PORT, Proto => 'tcp');
    last if $sock;
    select(undef, undef, undef, 0.5);
}
die "ERROR: could not reach Firefox debugger on 127.0.0.1:$PORT\n" unless $sock;
$sock->autoflush(1);

# RDP framing: <byte-length>:<json-payload>
sub read_msg {
    my ($s) = @_;
    my $lenstr = '';
    while (1) {
        my $c; my $n = sysread($s, $c, 1);
        die "ERROR: connection closed reading length\n" unless $n;
        last if $c eq ':';
        $lenstr .= $c;
    }
    my $len = $lenstr + 0;
    my $buf = '';
    while (length($buf) < $len) {
        my $chunk; my $n = sysread($s, $chunk, $len - length($buf));
        die "ERROR: connection closed reading body\n" unless $n;
        $buf .= $chunk;
    }
    return $json->decode($buf);
}
sub send_msg {
    my ($s, $obj) = @_;
    my $p = $json->encode($obj);
    print $s length($p) . ':' . $p;
}

my $hello = read_msg($sock);
print "GREETING: applicationType=" . ($hello->{applicationType} // '?') . "\n";

send_msg($sock, { to => 'root', type => 'getRoot' });
my $root = read_msg($sock);
my $addonsActor = $root->{addonsActor};
die "ERROR: no addonsActor in root (RDP not enabled?)\n" unless $addonsActor;

send_msg($sock, { to => $addonsActor, type => 'installTemporaryAddon', addonPath => $EXT });
my $res = read_msg($sock);
die "ERROR installTemporaryAddon: " . $json->encode($res) . "\n" if $res->{error};
my $id = ref($res->{addon}) eq 'HASH' ? ($res->{addon}{id} // '?') : ($res->{id} // '?');
print "INSTALLED: $id\n";
close($sock);

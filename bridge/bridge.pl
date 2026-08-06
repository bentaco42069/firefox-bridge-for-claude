#!/usr/bin/perl
# Claude Firefox Bridge - local command mailbox.
# The Firefox extension short-polls GET /poll and POSTs results to /result.
# Claude (via curl) POSTs to /command and reads GET /result/<id>.
# No external deps: IO::Socket::INET, JSON::PP, MIME::Base64 are all core.

use strict;
use warnings;
use IO::Socket::INET;
use JSON::PP;
use MIME::Base64 qw(decode_base64);
use File::Basename;
use Cwd qw(abs_path);

my $PORT = $ARGV[0] || 8765;

# Resolve project dir from this script's location so screenshots land in ../shots
my $scriptdir = dirname(abs_path($0));
my $projdir   = dirname($scriptdir);
my $shots_cyg = "$projdir/shots";
mkdir $shots_cyg unless -d $shots_cyg;

# Windows form of the shots dir (for paths handed back to the Read tool)
my $shots_win = $shots_cyg;
$shots_win =~ s{^/([a-zA-Z])/}{uc($1).":\\"}e;   # /c/ -> C:\
$shots_win =~ s{/}{\\}g;

my $json = JSON::PP->new->utf8->canonical;

my @queue;            # commands waiting for the extension
my %results;          # id => result (Perl structure)
my $counter = 0;

my $srv = IO::Socket::INET->new(
    LocalAddr => '127.0.0.1',
    LocalPort => $PORT,
    Listen    => 32,
    ReuseAddr => 1,
    Proto     => 'tcp',
) or die "Cannot bind 127.0.0.1:$PORT : $!\n";

print "Claude Firefox Bridge listening on http://localhost:$PORT\n";
print "Screenshots -> $shots_win\n";

sub send_response {
    my ($cli, $code, $ctype, $body) = @_;
    $body = '' unless defined $body;
    my $len = length($body);
    my $msg = "HTTP/1.1 $code\r\n"
        . "Content-Type: $ctype\r\n"
        . "Content-Length: $len\r\n"
        . "Access-Control-Allow-Origin: *\r\n"
        . "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        . "Access-Control-Allow-Headers: content-type\r\n"
        . "Connection: close\r\n"
        . "\r\n"
        . $body;
    print $cli $msg;
}

sub send_json {
    my ($cli, $code, $data) = @_;
    send_response($cli, $code, 'application/json', $json->encode($data));
}

while (my $cli = $srv->accept()) {
    $cli->autoflush(1);

    # --- read request line + headers ---
    my $reqline = <$cli>;
    unless (defined $reqline) { close $cli; next; }
    $reqline =~ s/\r?\n$//;
    my ($method, $path) = $reqline =~ m{^(\S+)\s+(\S+)};
    $method ||= ''; $path ||= '';

    my %h;
    while (my $line = <$cli>) {
        $line =~ s/\r?\n$//;
        last if $line eq '';
        if ($line =~ /^([\w-]+):\s*(.*)$/) { $h{lc $1} = $2; }
    }
    my $body = '';
    if (my $len = $h{'content-length'}) {
        read($cli, $body, $len) if $len > 0;
    }

    # --- routes ---
    if ($method eq 'OPTIONS') {
        send_response($cli, '204 No Content', 'text/plain', '');
        close $cli; next;
    }

    if ($method eq 'GET' && $path eq '/health') {
        send_json($cli, '200 OK', {
            ok => JSON::PP::true, queued => scalar(@queue),
            pending_results => scalar(keys %results), port => $PORT,
        });
    }
    elsif ($method eq 'GET' && $path eq '/poll') {
        if (@queue) {
            my $cmd = shift @queue;
            send_json($cli, '200 OK', $cmd);
        } else {
            send_response($cli, '200 OK', 'application/json', '{}');
        }
    }
    elsif ($method eq 'POST' && $path eq '/command') {
        my $data = eval { $json->decode($body) } || {};
        $counter++;
        my $id = $counter;
        push @queue, { id => $id, action => ($data->{action} // ''), params => ($data->{params} // {}) };
        send_json($cli, '200 OK', { id => $id });
    }
    elsif ($method eq 'POST' && $path eq '/result') {
        my $data = eval { $json->decode($body) };
        if ($data && defined $data->{id}) {
            my $result = $data->{result};
            # If the extension returned a screenshot, write it to disk and
            # hand back a file path instead of a huge base64 blob.
            if (ref($result) eq 'HASH' && defined $result->{png_base64}) {
                my $id = $data->{id};
                my $file_cyg = "$shots_cyg/shot-$id.png";
                my $file_win = "$shots_win\\shot-$id.png";
                if (open(my $fh, '>:raw', $file_cyg)) {
                    print $fh decode_base64($result->{png_base64});
                    close $fh;
                    delete $result->{png_base64};
                    $result->{png_path} = $file_win;
                } else {
                    $result->{error} = "could not write screenshot: $!";
                    delete $result->{png_base64};
                }
            }
            $results{ $data->{id} } = $result;
            send_json($cli, '200 OK', { ok => JSON::PP::true });
        } else {
            send_json($cli, '400 Bad Request', { error => 'missing id' });
        }
    }
    elsif ($method eq 'GET' && $path =~ m{^/result/(\d+)$}) {
        my $id = $1;
        if (exists $results{$id}) {
            my $r = delete $results{$id};
            send_json($cli, '200 OK', { done => JSON::PP::true, result => $r });
        } else {
            send_json($cli, '200 OK', { done => JSON::PP::false });
        }
    }
    elsif ($method eq 'GET' && ($path eq '/' || $path eq '/favicon.ico')) {
        send_response($cli, '200 OK', 'text/plain', "Claude Firefox Bridge running on port $PORT\n");
    }
    else {
        send_json($cli, '404 Not Found', { error => 'no such route', method => $method, path => $path });
    }

    close $cli;
}

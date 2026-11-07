<?php
declare(strict_types=1);

function reject(int $status, string $message): void
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    exit($message);
}

header('Cache-Control: private, no-store');
header('X-Content-Type-Options: nosniff');

$privateDirectory = dirname(__DIR__) . '/private';
$originFile = $privateDirectory . '/pixkit-gateway-origin';
$canonicalOrigin = 'https://app.pix-kit.com';
if (file_exists($originFile)) {
    $configuredOrigin = @file_get_contents($originFile, false, null, 0, 128);
    $canonicalOrigin = $configuredOrigin === false ? '' : trim($configuredOrigin);
}
if (!in_array($canonicalOrigin, ['https://pix-kit.com', 'https://app.pix-kit.com'], true)) {
    reject(503, 'Member service unavailable.');
}

$host = strtolower($_SERVER['HTTP_HOST'] ?? '');
if (strtolower($_SERVER['HTTPS'] ?? '') !== 'on' ||
    !in_array($host, ['pix-kit.com', 'app.pix-kit.com', 'www.pix-kit.com'], true)) {
    reject(421, 'Use the PixKit HTTPS origin.');
}

$method = $_SERVER['REQUEST_METHOD'] ?? '';
if (!in_array($method, ['GET', 'HEAD', 'POST'], true)) {
    header('Allow: GET, HEAD, POST');
    reject(405, 'Method not allowed.');
}

$target = $_SERVER['REQUEST_URI'] ?? '';
if (!preg_match('~^/(?!/)[^\x00-\x20\x7f#\\\\]*$~D', $target) || strlen($target) > 8192) {
    reject(400, 'Invalid request target.');
}

if ('https://' . $host !== $canonicalOrigin) {
    if ($canonicalOrigin !== 'https://pix-kit.com' || $method === 'POST') {
        reject(421, 'Use the PixKit HTTPS origin.');
    }
    // OAuth parameters and other query data must stay on the original origin.
    $path = explode('?', $target, 2)[0];
    if ($path === '/auth/callback') {
        $path = '/account/';
    }
    header('Location: ' . $canonicalOrigin . $path, true, 302);
    exit;
}

$limit = 64 * 1024;
$body = null;
if ($method === 'POST') {
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $limit) {
        reject(413, 'Request too large.');
    }
    $body = file_get_contents('php://input', false, null, 0, $limit + 1);
    if ($body === false || strlen($body) > $limit) {
        reject(413, 'Request too large.');
    }
}

if (!defined('CURLOPT_UNIX_SOCKET_PATH')) {
    reject(503, 'Member service unavailable.');
}

$requestHeaders = [];
// The private socket trusts only the address supplied by the host, never a browser header.
$clientAddress = $_SERVER['REMOTE_ADDR'] ?? '';
if (filter_var($clientAddress, FILTER_VALIDATE_IP) !== false) {
    $requestHeaders[] = 'X-PixKit-Client-IP: ' . $clientAddress;
}
foreach ([
    'CONTENT_TYPE' => 'Content-Type',
    'HTTP_COOKIE' => 'Cookie',
    'HTTP_ORIGIN' => 'Origin',
    'HTTP_X_PIXKIT_ACCOUNT' => 'X-PixKit-Account',
] as $key => $name) {
    if (isset($_SERVER[$key])) {
        $requestHeaders[] = $name . ': ' . $_SERVER[$key];
    }
}

$responseHeaders = [];
$responseBody = '';
$responseLimit = 16 * 1024 * 1024;
$publicAssetCache = false;
$hasCookies = false;
$upstream = curl_init('http://localhost' . $target);
curl_setopt_array($upstream, [
    CURLOPT_UNIX_SOCKET_PATH => $privateDirectory . '/pixkit.sock',
    CURLOPT_PROXY => '',
    CURLOPT_PATH_AS_IS => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 2,
    CURLOPT_TIMEOUT => 20,
    CURLOPT_CUSTOMREQUEST => $method,
    CURLOPT_NOBODY => $method === 'HEAD',
    CURLOPT_HTTPHEADER => $requestHeaders,
    CURLOPT_HEADERFUNCTION => static function ($connection, string $line) use (&$responseHeaders, &$publicAssetCache, &$hasCookies): int {
        if (str_starts_with($line, 'HTTP/')) {
            $responseHeaders = [];
            $publicAssetCache = false;
            $hasCookies = false;
        } elseif (preg_match('/^Cache-Control:\s*public, max-age=3600\s*$/iD', $line)) {
            $publicAssetCache = true;
        } elseif (preg_match('/^(content-type|content-security-policy|location|referrer-policy|retry-after|server-timing|set-cookie|x-robots-tag):/i', $line)) {
            $hasCookies = $hasCookies || stripos($line, 'Set-Cookie:') === 0;
            $responseHeaders[] = rtrim($line, "\r\n");
        }
        return strlen($line);
    },
    CURLOPT_WRITEFUNCTION => static function ($connection, string $chunk) use (&$responseBody, $responseLimit): int {
        if (strlen($responseBody) + strlen($chunk) > $responseLimit) {
            return 0;
        }
        $responseBody .= $chunk;
        return strlen($chunk);
    },
]);
if ($body !== null) {
    curl_setopt($upstream, CURLOPT_POSTFIELDS, $body);
}
$result = curl_exec($upstream);
$status = (int) curl_getinfo($upstream, CURLINFO_RESPONSE_CODE);
if ($result === false || $status < 200 || $status > 599) {
    reject(503, 'Member service unavailable.');
}

foreach ($responseHeaders as $line) {
    header($line, false);
}
if ($status === 200 && $method !== 'POST' && $publicAssetCache && !$hasCookies &&
    preg_match('~^/(?:assets|_platform)/~D', $target)) {
    header('Cache-Control: public, max-age=3600');
}
http_response_code($status);
echo $responseBody;

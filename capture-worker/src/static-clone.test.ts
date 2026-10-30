import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  buildStaticClone,
  cleanupStaticClone,
  inferExtension,
  planStaticClone,
  replacementForReference,
  rewriteCss,
  sanitizePathComponent,
  urlToLocalPath,
} from './static-clone.js'
import type { CloneInputResource } from './types.js'

test('ánh xạ URL thành path portable và chặn traversal/tên dành riêng', () => {
  assert.equal(urlToLocalPath('https://example.com/'), 'example.com/index.html')
  assert.equal(urlToLocalPath('https://example.com/%2e%2e/CON/app'), 'example.com/_CON/app')
  assert.equal(urlToLocalPath('https://example.com/a%2Fb/app'), 'example.com/a_b/app')
  assert.equal(inferExtension('example.com/assets/site', 'text/css; charset=utf-8'), 'example.com/assets/site.css')
  assert.equal(sanitizePathComponent('hello?.js'), 'hello_.js')
  assert.equal(sanitizePathComponent('café.html'), 'caf_.html')
})

test('query variant được tách path collision nhưng không lộ query value khi rewrite', () => {
  const resources = [
    input('https://example.com/app.js?token=secret-one', 'script', 'application/javascript', 'one'),
    input('https://example.com/app.js?token=secret-two', 'script', 'application/javascript', 'two'),
    input('https://cdn.example.net/app.js?token=external-secret', 'script', 'application/javascript', 'external'),
  ]
  const plan = planStaticClone('https://example.com/', resources, 20)
  assert.equal(plan.resources[0]?.localPath, 'example.com/app.js')
  assert.equal(plan.resources[1]?.localPath, 'example.com/app_1.js')
  assert.equal(plan.resources[2]?.skipReason, 'EXTERNAL_ORIGIN')
  assert.equal(
    replacementForReference('/app.js?token=secret-two', 'https://example.com/', plan.replacements),
    'app_1.js',
  )
  const redacted = replacementForReference(
    'https://cdn.example.net/app.js?token=external-secret',
    'https://example.com/',
    plan.replacements,
  )
  assert.doesNotMatch(redacted, /external-secret/u)
  assert.match(redacted, /REDACTED/u)
})

test('content-addressed resources giữ extension và chỉ deduplicate representation tương thích', () => {
  const resources = [
    input('https://example.com/shared-a', 'script', 'application/javascript', 'same-body'),
    input('https://example.com/shared-b', 'script', 'text/javascript', 'same-body'),
    input('https://example.com/shared-c', 'font', 'font/woff2', 'same-body'),
    input('https://example.com/styles/app', 'stylesheet', 'text/css', 'body{color:#123}'),
  ]
  const plan = planStaticClone('https://example.com/', resources, 20, { contentAddressedResources: true })

  assert.equal(plan.resources[0]?.localPath, plan.resources[1]?.localPath)
  assert.match(plan.resources[0]?.localPath ?? '', /^assets\/[0-9a-f]{64}\.js$/u)
  assert.match(plan.resources[2]?.localPath ?? '', /^assets\/[0-9a-f]{64}\.woff2$/u)
  assert.notEqual(plan.resources[0]?.localPath, plan.resources[2]?.localPath)
  assert.match(plan.resources[3]?.localPath ?? '', /^assets\/[0-9a-f]{64}\.css$/u)
})

test('Design Clone admits only observed HTTPS visual resources with matching MIME', async () => {
  const resources = [
    input('https://cdn.example.net/styles/site.css?token=private', 'stylesheet', 'text/css',
      '@font-face{font-family:fixture;src:url(../fonts/site.woff2?token=secret)}'),
    input('https://cdn.example.net/fonts/site.woff2?token=secret', 'font', 'font/woff2', 'font'),
    input('https://images.example.net/hero.webp', 'image', 'image/webp', 'image'),
    input('https://cdn.example.net/analytics.js', 'script', 'application/javascript', 'script'),
    input('https://cdn.example.net/fake-image', 'image', 'text/html', 'html'),
    input('https://cdn.example.net/fake-style', 'stylesheet', 'application/javascript', 'script'),
    input('http://cdn.example.net/insecure.png', 'image', 'image/png', 'image'),
    input('https://user:password@cdn.example.net/private.png', 'image', 'image/png', 'image'),
    { ...input('https://cdn.example.net/missing.png', 'image', 'image/png', ''), body: null,
      skipReason: 'REQUEST_FAILED' },
  ]
  const legacy = planStaticClone('https://example.com/', resources)
  assert.ok(legacy.resources.every(resource => resource.localPath === null))
  const plan = planStaticClone('https://example.com/', resources, 20,
    { contentAddressedResources: true, allowExternalVisualResources: true })
  assert.ok(plan.resources.slice(0, 3).every(resource => resource.localPath !== null))
  assert.ok(plan.resources.slice(3).every(resource => resource.localPath === null))
  assert.equal(plan.resources.at(-1)?.skipReason, 'REQUEST_FAILED')
  const css = rewriteCss(resources[0]!.body!.toString(), resources[0]!.sourceUrl, plan.resources[0]!.localPath!, plan)
  assert.doesNotMatch(css, /secret|private|https:/u)
  assert.match(css, /url\([a-f0-9]+\.woff2\)/u)
  const build = await buildStaticClone(plan, Buffer.from('<main>Design</main>'), { bundleOnly: true })
  assert.equal(build.packagedCount, 4)
  const manifest = JSON.parse(build.manifest!.toString())
  assert.equal(manifest.policy.sameOriginOnly, false)
  assert.deepEqual(manifest.policy.externalResourceTypes, ['stylesheet', 'image', 'font'])
  assert.doesNotMatch(build.manifest!.toString(), /token=(?:secret|private)|user:password/u)
})

test('external visual resources share the existing file and byte ceilings', () => {
  const resources = Array.from({ length: 100 }, (_, index) =>
    input(`https://cdn.example.net/${index}.png`, 'image', 'image/png', String(index)))
  const options = { contentAddressedResources: true, allowExternalVisualResources: true }
  const plan = planStaticClone('https://example.com/', resources, 0, options)
  assert.equal(plan.resources.filter(resource => resource.localPath).length, 99)
  assert.equal(plan.resources.at(-1)?.skipReason, 'FILE_COUNT_BUDGET_EXCEEDED')
  const byteLimited = planStaticClone('https://example.com/', resources.slice(0, 1), 52_428_800, options)
  assert.equal(byteLimited.resources[0]?.skipReason, 'CLONE_INPUT_BUDGET_EXCEEDED')
})

test('tạo ZIP bounded và manifest trung thực cho partial clone', async () => {
  const resources = [
    input('https://example.com/styles/site?theme=private', 'stylesheet', 'text/css',
      'body{background:url("../img/hero.png?sig=secret")}', true),
    input('https://example.com/img/hero.png?sig=secret', 'image', 'image/png', 'png'),
    { ...input('https://example.com/missing.js', 'script', 'application/javascript', ''), body: null,
      skipReason: 'BODY_UNAVAILABLE' },
  ]
  const plan = planStaticClone('https://example.com/', resources, 30)
  const css = rewriteCss(resources[0]!.body!.toString('utf8'), resources[0]!.sourceUrl,
    plan.resources[0]!.localPath!, plan)
  assert.doesNotMatch(css, /sig=secret/u)
  assert.match(css, /hero\.png/u)
  const imported = rewriteCss(
    '@import "https://example.com/styles/site?theme=private";',
    'https://example.com/base.css',
    'example.com/base.css',
    plan,
  )
  assert.doesNotMatch(imported, /theme=private/u)
  assert.match(imported, /styles\/site\.css/u)

  const build = await buildStaticClone(plan, Buffer.from('<html><body>clone</body></html>'))
  try {
    assert.equal(build.status, 'PARTIAL')
    assert.equal(build.packagedCount, 3)
    assert.equal(build.skippedCount, 1)
    assert.ok(build.archivePath)
    assert.ok(build.archiveBytes && build.archiveBytes > 0)
    const signature = (await readFile(build.archivePath!)).subarray(0, 4).toString('hex')
    assert.equal(signature, '504b0304')
    const manifest = JSON.parse(build.manifest!.toString('utf8')) as { completenessCode: string; files: unknown[] }
    assert.equal(manifest.completenessCode, 'TRUNCATED_RESOURCE')
    assert.equal(manifest.files.length, 4)
    assert.doesNotMatch(build.manifest!.toString('utf8'), /private|secret/u)
    assert.deepEqual(build.siteBundle?.resourceGaps?.map((gap) => gap.reason), [
      'TRUNCATED_RESOURCE', 'BODY_UNAVAILABLE',
    ])
    assert.doesNotMatch(JSON.stringify(build.siteBundle?.resourceGaps), /private|secret/u)
  } finally {
    await cleanupStaticClone(build)
  }
})

test('site bundles keep partial results and budgets without creating a page ZIP', async () => {
  const resources = [
    input('https://example.com/app.css', 'stylesheet', 'text/css', 'body{background:url(logo.png)}'),
    input('https://example.com/logo.png', 'image', 'image/png', 'image'),
    { ...input('https://example.com/missing.js', 'script', 'application/javascript', ''),
      body: null, skipReason: 'REQUEST_FAILED' },
  ]
  const plan = planStaticClone('https://example.com/', resources, 100, { contentAddressedResources: true })
  const result = await buildStaticClone(plan, Buffer.from('<main>Bundle</main>'), { bundleOnly: true })
  assert.equal(result.status, 'PARTIAL')
  assert.equal(result.archivePath, null)
  assert.equal(result.archiveBytes, null)
  assert.equal(result.temporaryDirectory, null)
  assert.equal(result.packagedCount, 3)
  assert.equal(result.skippedCount, 1)
  assert.deepEqual(result.siteBundle?.resourceGaps?.map((gap) => gap.reason), ['REQUEST_FAILED'])
  assert.equal(result.siteBundle?.files.find((file) => file.contentType === 'text/css')?.body.toString(),
    'body{background:url(logo.png)}')

  const largeHtml = await buildStaticClone(plan, Buffer.alloc(52_428_801), { bundleOnly: true })
  assert.equal(largeHtml.status, 'FAILED')
  assert.equal(largeHtml.failureCode, 'CLONE_INPUT_BUDGET_EXCEEDED')
  assert.equal(largeHtml.siteBundle, null)
})

function input(
  sourceUrl: string,
  resourceType: string,
  mimeType: string,
  value: string,
  wasTruncated = false,
): CloneInputResource {
  return {
    sequence: 1,
    sourceUrl,
    publicUrl: sourceUrl.replace(/=.*/u, '=[REDACTED]'),
    resourceType,
    mimeType,
    body: Buffer.from(value),
    wasTruncated,
    skipReason: null,
  }
}

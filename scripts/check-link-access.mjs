import { XMLParser } from "fast-xml-parser";

const endpoint = "https://api.edunet.net/search/searchApi/search";
const apiKey = process.env.EDUNET_API_KEY?.trim();
const domain = process.env.EDUNET_DOMAIN?.trim();
if (!apiKey || !domain) throw new Error("EDUNET_API_KEY and EDUNET_DOMAIN are required");

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });

if (process.argv.includes("--discover-bundle")) {
  const response = await fetch("https://www.edunet.net/assets/index.js", { signal: withTimeout() });
  if (!response.ok) throw new Error(`bundle HTTP ${response.status}`);
  const source = await response.text();
  const needles = ["clssStdDt", "downloadFile", "fileDownload", "atchFile", "atchfile", "previewDoc"];
  const strings = [...source.matchAll(/["']([^"']{1,240})["']/g)]
    .map((match) => match[1])
    .filter((value) => /clssStdDt|download|atchFile|fileDown|previewDoc|ClssStdDtView|ContsMvGllryView/i.test(value));
  const contexts = [];
  for (const needle of needles) {
    let offset = 0;
    while ((offset = source.indexOf(needle, offset)) !== -1 && contexts.length < 80) {
      contexts.push({ needle, context: source.slice(Math.max(0, offset - 300), offset + 500) });
      offset += needle.length;
    }
  }
  process.stdout.write(`${JSON.stringify({ bytes: source.length, strings: [...new Set(strings)].sort(), contexts }, null, 2)}\n`);
  process.exit(0);
}
const plans = [
  { category: "lsn_design", label: "수업설계", queries: ["수업", "과학", "프로젝트", "환경"] },
  { category: "evl_data", label: "평가자료", queries: ["광합성", "과학", "평가"] },
  { category: "ednwkst", label: "주제별 학습자료", queries: ["광합성", "과학", "환경"] },
];

function array(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function clean(value) {
  return String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function withTimeout(milliseconds = 15_000) {
  return AbortSignal.timeout(milliseconds);
}

async function search(query, category) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    kwd: query,
    collection: category,
    sort: "r",
    searchType: "all",
    pageNum: "1",
    pageSize: "10",
    sno: apiKey,
    svc_version: "4.5",
    svc_domain: domain,
  }).toString();
  const response = await fetch(url, { signal: withTimeout() });
  if (!response.ok) throw new Error(`search HTTP ${response.status}`);
  const parsed = parser.parse(await response.text());
  return array(parsed?.search?.totalResults?.dataList?.data).map((item) => ({
    id: clean(item.conts_id ?? item.contents_id),
    title: clean(item.ttl),
    categoryName: clean(item.ctgry_nm ?? item.category_nm),
    url: clean(item.conts_link),
    fileNames: clean(item.file_nm).split(":").map(clean).filter(Boolean),
    fileExtensions: clean(item.file_extn).split(":").map(clean).filter(Boolean),
  }));
}

function decodeEntities(value) {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", "\"").replaceAll("&#39;", "'");
}

function inspectHtml(html, baseUrl) {
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);
  const bodyText = clean(html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " "));
  const attachmentLinks = [];
  const linkPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(linkPattern)) {
    const href = decodeEntities(match[1]);
    const label = clean(match[2]);
    if (/\.(?:pdf|hwp|hwpx|docx?|xlsx?|pptx?|zip)(?:$|[?#])/i.test(href) || /첨부|다운로드|파일/i.test(label + href)) {
      try {
        attachmentLinks.push({ label, url: new URL(href, baseUrl).href });
      } catch {}
    }
  }
  return {
    documentTitle: title,
    visibleTextLength: bodyText.length,
    visibleTextSample: bodyText.slice(0, 180),
    loginIndicator: /로그인|아이디|비밀번호|회원가입/.test(bodyText),
    spaShellIndicator: bodyText.length < 250 || /id=["'](?:app|root)["']/.test(html),
    attachmentLinks,
    scriptSources: [...html.matchAll(/<script\b[^>]*src\s*=\s*["']([^"']+)["']/gi)].map((m) => {
      try { return new URL(decodeEntities(m[1]), baseUrl).href; } catch { return null; }
    }).filter(Boolean),
  };
}

async function inspectPage(url) {
  if (!/^https?:\/\//i.test(url)) return { error: "missing_or_invalid_url" };
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; edunet-mcp-access-check/0.1)" },
      signal: withTimeout(),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const html = await response.text();
    return {
      status: response.status,
      finalUrl: response.url,
      contentType,
      redirected: response.redirected,
      ...inspectHtml(html, response.url),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.name : "fetch_error" };
  }
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; edunet-mcp-access-check/0.1)" },
    signal: withTimeout(),
  });
  const body = await response.json();
  return { status: response.status, contentType: response.headers.get("content-type") ?? "", body };
}

function fileMetadata(file) {
  const allowed = ["fileRscId", "fileLgcNm", "filePhysNm", "extn", "fileByte", "fileType", "fileNm", "orgnlFileNm", "fileExtn", "fileExt", "fileSize", "fileSz", "atchFileNm", "streFileNm"];
  return Object.fromEntries(allowed.filter((key) => file?.[key] !== undefined).map((key) => [key, file[key]]));
}

async function probeDownload(fileRscId) {
  if (!fileRscId) return { status: "no_file_id" };
  try {
    const response = await fetch(`https://api.edunet.net/main/fileRsc/downloadFile/${encodeURIComponent(fileRscId)}`, {
      headers: { range: "bytes=0-31", "user-agent": "Mozilla/5.0 (compatible; edunet-mcp-access-check/0.1)" },
      signal: withTimeout(),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    let json = null;
    if ((response.headers.get("content-type") ?? "").includes("application/json") && bytes.byteLength < 20_000) {
      try { json = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch {}
    }
    const result = {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      contentRange: response.headers.get("content-range"),
      contentLength: response.headers.get("content-length"),
      contentDispositionPresent: response.headers.has("content-disposition"),
      receivedBytes: bytes.byteLength,
      magicHex: Buffer.from(bytes.subarray(0, 8)).toString("hex"),
      apiSuccess: json?.success ?? null,
      temporaryUrlReturned: typeof json?.data === "string" && /^https:\/\//.test(json.data),
    };
    if (typeof json?.data === "string" && /^https:\/\//.test(json.data)) {
      try {
        // Match z7 in the official public assets/index.js. Never persist the signed URL.
        const downloadUrl = json.data
          .replace("https://edunet-data.kr.object.gov-ncloudstorage.com/", "https://educon.edunet.net/")
          .replace("https://edunet-vod.kr.object.gov-ncloudstorage.com/", "https://educdn.edunet.net/")
          .split("&X-Amz-Algorithm")[0].replace(/%22$/, "");
        const safeUrl = new URL(downloadUrl);
        if (!["educon.edunet.net", "educdn.edunet.net"].includes(safeUrl.hostname)) {
          return { ...result, fileBytes: { error: "unexpected_download_host" } };
        }
        const fileResponse = await fetch(downloadUrl, {
          headers: { range: "bytes=0-31", "user-agent": "Mozilla/5.0 (compatible; edunet-mcp-access-check/0.1)" },
          signal: withTimeout(),
        });
        const reader = fileResponse.body?.getReader();
        const chunk = reader ? await reader.read() : { value: undefined };
        void reader?.cancel().catch(() => {});
        const fileBytes = chunk.value ?? new Uint8Array();
        result.fileBytes = {
          url: safeUrl.origin + safeUrl.pathname,
          status: fileResponse.status,
          contentType: fileResponse.headers.get("content-type") ?? "",
          contentRange: fileResponse.headers.get("content-range"),
          contentLength: fileResponse.headers.get("content-length"),
          contentDispositionPresent: fileResponse.headers.has("content-disposition"),
          receivedBytes: fileBytes.byteLength,
          magicHex: Buffer.from(fileBytes.subarray(0, 12)).toString("hex"),
        };
      } catch (error) {
        result.fileBytes = { error: error instanceof Error ? error.name : "fetch_error" };
      }
    }
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.name : "fetch_error" };
  }
}

const selected = [];
for (const plan of plans) {
  const seen = new Set();
  for (const query of plan.queries) {
    const items = await search(query, plan.category);
    for (const item of items) {
      const identity = item.id || item.url;
      if (!identity || seen.has(identity) || !item.url) continue;
      seen.add(identity);
      selected.push({ category: plan.category, categoryLabel: plan.label, query, ...item });
      if (seen.size === 3) break;
    }
    if (seen.size === 3) break;
  }
  if (seen.size < 3) throw new Error(`${plan.category}: only ${seen.size} distinct linked items found`);
}

if (process.argv.includes("--probe-details")) {
  for (const item of selected) {
    const pageUrl = new URL(item.url);
    let detailUrl;
    if (item.category === "ednwkst") {
      detailUrl = new URL("https://api.edunet.net/main/conts/getContsData");
      detailUrl.search = new URLSearchParams({ contsId: item.id, prgrmId: "0" }).toString();
    } else {
      detailUrl = new URL(`https://api.edunet.net/main/clssStdDt/getClssStdDtInfo/${encodeURIComponent(item.id)}`);
      detailUrl.search = pageUrl.search;
    }
    try {
      const detail = await getJson(detailUrl);
      const data = detail.body?.data ?? detail.body;
      const fileList = array(data?.fileList ?? data?.clssStdDtInfo?.fileList ?? data?.contsInfo?.fileList);
      item.detailApi = {
        status: detail.status,
        contentType: detail.contentType,
        success: detail.body?.success ?? null,
        endpoint: detailUrl.origin + detailUrl.pathname,
        id: data?.clssStdDtInfo?.contsId ?? data?.result?.contsId ?? null,
        title: clean(data?.clssStdDtInfo?.contsNm ?? data?.result?.contsNm ?? data?.result?.shrtNm ?? data?.contsInfo?.contsNm ?? data?.contsNm),
        contentLength: clean(data?.clssStdDtInfo?.contsCn ?? data?.result?.contsCn ?? data?.contsInfo?.contsCn ?? data?.contsCn).length,
        dataKeys: Object.keys(data ?? {}),
        fileList: fileList.map(fileMetadata),
      };
      const firstFileId = fileList[0]?.fileRscId;
      item.downloadProbe = await probeDownload(firstFileId);
    } catch (error) {
      item.detailApi = { error: error instanceof Error ? error.name : "fetch_error" };
    }
  }
  process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), items: selected }, null, 2)}\n`);
  process.exit(0);
}

for (const item of selected) item.page = await inspectPage(item.url);
process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), items: selected }, null, 2)}\n`);

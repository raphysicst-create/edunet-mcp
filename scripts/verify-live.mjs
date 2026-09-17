// 실제 EDUNET에 연결된 MCP 프로세스를 확인하는 수동 통합 테스트입니다.
// 외부 서비스와 API 키가 필요하므로 npm test에는 포함하지 않습니다.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadConfig } from "../dist/config.js";
import { searchOutputSchema } from "../dist/schema.js";

const cases = [];

async function check(name, test) {
  try {
    const detail = await test();
    cases.push({ name, passed: true, detail });
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    cases.push({ name, passed: false, detail: message });
    console.log(`FAIL  ${name} - ${message}`);
  }
}

async function main() {
  const config = loadConfig();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: { EDUNET_API_KEY: config.apiKey, EDUNET_DOMAIN: config.domain },
    stderr: "pipe",
  });
  let logs = "";
  transport.stderr?.on("data", chunk => { logs += chunk.toString(); });
  const client = new Client({ name: "edunet-live-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), ["search_edunet"], "search_edunet 도구를 찾을 수 없습니다");

    const callSearch = async arguments_ => {
      const result = await client.callTool(
        { name: "search_edunet", arguments: arguments_ },
        undefined,
        { timeout: 50_000 },
      );
      if (result.isError) throw new Error(result.content?.[0]?.text ?? "MCP 검색 오류");
      assert.ok(!JSON.stringify(result).includes(config.apiKey), "응답에 API 키가 노출되었습니다");
      return searchOutputSchema.parse(result.structuredContent);
    };

    let firstPage;

    await check("일반 검색", async () => {
      firstPage = await callSearch({ query: "광합성", page: 1, pageSize: 2 });
      assert.ok(firstPage.items.length > 0, "'광합성' 검색 결과가 없습니다");
      assert.equal(firstPage.pagination.page, 1);
      return `${firstPage.pagination.returnedCount}건 / 전체 ${firstPage.pagination.totalCount ?? "미제공"}건`;
    });

    await check("카테고리 검색", async () => {
      const output = await callSearch({ query: "과학", categories: ["evl_data"], pageSize: 2 });
      assert.deepEqual(output.conditions.categories, ["evl_data"], "카테고리 조건이 응답에 유지되지 않았습니다");
      assert.ok(output.items.length > 0, "평가자료 카테고리 검색 결과가 없습니다");
      return `평가자료 ${output.pagination.returnedCount}건`;
    });

    await check("0건 검색", async () => {
      const output = await callSearch({
        query: "존재하지않는에듀넷검증검색어9f7c2a6e4d8b1",
        searchType: "title",
        pageSize: 2,
      });
      assert.equal(output.items.length, 0, "0건용 검색어에서 자료가 반환되었습니다");
      assert.equal(output.pagination.totalCount, 0, "전체 건수가 0이 아닙니다");
      assert.equal(output.pagination.hasNextPage, false, "0건 검색에 다음 페이지가 표시되었습니다");
      return "0건과 다음 페이지 없음 확인";
    });

    await check("페이지 처리", async () => {
      assert.ok(firstPage, "일반 검색 1페이지를 확인하지 못했습니다");
      assert.equal(firstPage.pagination.hasNextPage, true, "1페이지에 다음 페이지가 없습니다");
      assert.equal(firstPage.pagination.nextPage, 2, "다음 페이지 번호가 2가 아닙니다");
      const secondPage = await callSearch({ query: "광합성", page: 2, pageSize: 2 });
      assert.equal(secondPage.pagination.page, 2);
      assert.ok(secondPage.items.length > 0, "2페이지 검색 결과가 없습니다");
      assert.notDeepEqual(
        secondPage.items.map(item => item.id),
        firstPage.items.map(item => item.id),
        "1페이지와 2페이지 자료가 같습니다",
      );
      return `1페이지 ${firstPage.items.length}건, 2페이지 ${secondPage.items.length}건`;
    });

    await check("잘못된 입력", async () => {
      const result = await client.callTool({
        name: "search_edunet",
        arguments: { query: "광합성", page: 51 },
      });
      assert.equal(result.isError, true, "잘못된 page 입력이 오류로 처리되지 않았습니다");
      assert.match(result.content?.[0]?.text ?? "", /INVALID_INPUT/, "오류 안내에 INVALID_INPUT이 없습니다");
      return "page=51 거부 확인";
    });
  } finally {
    await client.close();
  }

  assert.ok(!logs.includes(config.apiKey), "MCP stderr에 API 키가 노출되었습니다");
  const passed = cases.filter(test => test.passed).length;
  console.log(`\n결과: ${passed}/${cases.length} PASS`);
  if (passed !== cases.length) process.exitCode = 1;
}

main().catch(error => {
  // SDK나 upstream 원문은 자격 증명을 포함할 수 있으므로 그대로 출력하지 않습니다.
  const message = error instanceof Error && error.message.startsWith("EDUNET_")
    ? error.message
    : "MCP 연결 또는 테스트 실행에 실패했습니다";
  console.error(`FAIL  실행 준비 - ${message}`);
  process.exitCode = 1;
});

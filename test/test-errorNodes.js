import { parser } from "../dist/index.es.js";
import { expect } from "chai";

// Count error nodes in a parse tree using the @lezer/common cursor API.
export function testNodes(doc) {
  let tree = parser.parse(doc);
  let errorNodeCount = 0;
  let cursor = tree.cursor();
  do {
    if (cursor.type.isError) errorNodeCount += 1;
  } while (cursor.next());
  return errorNodeCount;
}

describe("Error Node Test", function () {
  it("Should return zero if the query is valid", function () {
    expect(testNodes("select * from val;")).to.equal(0);
  });
});

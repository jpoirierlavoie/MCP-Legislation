import { z } from "zod";
import { toJsonSchemaCompat } from "./node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js";
const LANG = z.enum(["fr","en"]).default("fr").describe("Langue : 'fr' (défaut) ou 'en'.");
const shapes = {
  list_laws: { fonction: z.string().optional(), forum: z.string().optional(), subject: z.string().optional(), structure: z.boolean().default(true), lang: LANG.optional() },
  list_subjects: { lang: LANG.optional() },
  related_laws: { law: z.string(), rel_type: z.string().optional(), direction: z.enum(["out","in","both"]).default("both"), limit: z.number().int().min(1).max(200).optional(), lang: LANG.optional() },
  find_relevant: { query: z.string(), limit: z.number().int().min(1).max(50).optional(), lang: LANG },
  get_article: { law: z.string(), article: z.coerce.string(), lang: LANG },
  get_articles: { law: z.string(), from: z.coerce.string().optional(), to: z.coerce.string().optional(), numbers: z.array(z.coerce.string()).optional(), lang: LANG, limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() },
  get_structure: { law: z.string(), lang: LANG, root_path: z.string().optional(), depth: z.number().int().min(1).max(9).optional() },
  get_division: { law: z.string(), path: z.string().optional(), division_id: z.number().int().optional(), lang: LANG, include_text: z.boolean().default(true), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() },
  search_text: { query: z.string(), law: z.string().optional(), lang: LANG, limit: z.number().int().min(1).max(50).optional(), offset: z.number().int().min(0).optional() },
  resolve_reference: { citation: z.string(), lang: LANG },
};
for (const [n, s] of Object.entries(shapes)) {
  const js = toJsonSchemaCompat(z.object(s), { strictUnions: true, pipeStrategy: "input" });
  console.log("### " + n);
  console.log(JSON.stringify({ required: js.required ?? [], addl: js.additionalProperties, props: js.properties }, null, 0));
}
// parse probes
console.log("--- parse probes ---");
console.log("list_laws {}:", JSON.stringify(z.object(shapes.list_laws).parse({})));
console.log("related {law:cpc}:", JSON.stringify(z.object(shapes.related_laws).parse({law:"cpc"})));
console.log("find_relevant {query:x}:", JSON.stringify(z.object(shapes.find_relevant).parse({query:"x"})));
console.log("get_article {law,article:1457}:", JSON.stringify(z.object(shapes.get_article).parse({law:"ccq",article:1457})));
try { console.log("get_article article null:", JSON.stringify(z.object(shapes.get_article).parse({law:"ccq",article:null}))); } catch(e){ console.log("get_article article null REFUSE"); }
try { console.log("get_articles numbers [1457,'x']:", JSON.stringify(z.object(shapes.get_articles).parse({law:"ccq",numbers:[1457,"x"]}))); } catch(e){ console.log("numbers coercion REFUSE"); }
console.log("get_division {law,path}:", JSON.stringify(z.object(shapes.get_division).parse({law:"ccq",path:"p"})));
console.log("strip unknown:", JSON.stringify(z.object(shapes.search_text).parse({query:"x", bogus:1})));
try { console.log("get_article article [1,2]:", JSON.stringify(z.object(shapes.get_article).parse({law:"ccq",article:[1,2]}))); } catch(e){ console.log("article array REFUSE"); }
try { console.log("get_article article {}:", JSON.stringify(z.object(shapes.get_article).parse({law:"ccq",article:{}}))); } catch(e){ console.log("article object REFUSE"); }
try { console.log("lang bogus:", JSON.stringify(z.object(shapes.search_text).parse({query:"x", lang:"es"}))); } catch(e){ console.log("lang 'es' REFUSE"); }

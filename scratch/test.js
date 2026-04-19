import { toVertexRequest, toOpenAIResponse } from "../src/transform.js";

async function runTests() {
  console.log("--- Testing toVertexRequest -> Tools ---");
  const requestBody = {
    model: "gemini-flash",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What is the weather in SF?" }
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "getWeather",
          description: "Get the current weather",
          parameters: { type: "object", properties: { location: { type: "string" } } }
        }
      }
    ]
  };

  const vertexPayload = await toVertexRequest(requestBody);
  console.log(JSON.stringify(vertexPayload, null, 2));

  console.log("\n--- Testing toVertexRequest -> Tool Result ---");
  const reqWithResult = {
    messages: [
      { role: "user", content: "What is the weather?" },
      { role: "assistant", tool_calls: [{ id: "call1", type: "function", function: { name: "getWeather", arguments: '{"location":"SF"}' } }] },
      { role: "tool", name: "getWeather", tool_call_id: "call1", content: '{"temp": 72}' }
    ]
  };
  const vertexPayload2 = await toVertexRequest(reqWithResult);
  console.log(JSON.stringify(vertexPayload2, null, 2));

  console.log("\n--- Testing toOpenAIResponse -> Tool Calls ---");
  const vertexMockResponse = {
    text: "",
    toolCalls: [
      { name: "getWeather", args: { location: "SF" } }
    ]
  };

  const finalRes = toOpenAIResponse(vertexMockResponse);
  console.log(JSON.stringify(finalRes, null, 2));
}

runTests().catch(console.error);

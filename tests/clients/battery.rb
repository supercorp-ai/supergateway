# The Ruby half of the cross-client conformance battery.
#
# A fifth implementation, and a fifth language runtime. `ruby-mcp-client` is a
# community client rather than the official gem, which is worth knowing: it is
# the kind of client a user might actually reach for, and it makes its own
# choices about parsing.
require 'json'
require 'mcp_client'

SEPARATORS = "before middle after"
UNICODE = "a\u{1F469}‍\u{1F469}‍\u{1F467}‍\u{1F466}b عربى c éèê d 漢字 e \u{1D518}\u{1D52B}\u{1D526} f"
PLAIN = 'plain-result'
BIG_LENGTH = Integer(ENV.fetch('BIG_LENGTH', 1024 * 1024))

$results = []

def record(name, ok, detail = '')
  $results << { name: name, ok: !!ok, detail: detail.to_s[0, 90] }
end

def text_of(res)
  items = res.is_a?(Hash) ? (res['content'] || res[:content]) : nil
  return nil unless items
  item = items.find { |c| (c['type'] || c[:type]) == 'text' }
  item && (item['text'] || item[:text])
end

url = ARGV[0]
kind = ARGV[1]

begin
  config =
    if kind == 'sse'
      MCPClient.sse_config(base_url: url)
    else
      MCPClient.streamable_http_config(base_url: url)
    end
  client = MCPClient.create_client(mcp_server_configs: [config])
  tools = client.list_tools
  record('connect', true, '')
  names = tools.map(&:name).sort
  want = %w[echo large plain separators shadowedError slow throws toolError unicode]
  record('tools/list', names == want, names.join(','))
rescue StandardError => e
  record('connect', false, "#{e.class}: #{e.message}")
  puts JSON.generate($results)
  exit 0
end

def call(client, name, args = {})
  client.call_tool(name, args)
end

[['plain text', 'plain', PLAIN],
 ['line separators', 'separators', SEPARATORS],
 ['unicode', 'unicode', UNICODE]].each do |label, tool, expect|
  begin
    got = text_of(call(client, tool))
    record(label, got == expect, got == expect ? '' : got.inspect)
  rescue StandardError => e
    record(label, false, "#{e.class}: #{e.message}")
  end
end

begin
  got = text_of(call(client, 'large'))
  record('1 MB result', got && got.bytesize == BIG_LENGTH, "length #{got ? got.bytesize : 'nil'}")
rescue StandardError => e
  record('1 MB result', false, "#{e.class}: #{e.message}")
end

begin
  res = call(client, 'toolError')
  flag = res.is_a?(Hash) ? (res['isError'] || res[:isError]) : nil
  record('tool error stays a result', flag == true, "isError=#{flag.inspect}")
rescue StandardError => e
  record('tool error stays a result', false, "threw #{e.class}")
end

begin
  res = call(client, 'throws')
  flag = res.is_a?(Hash) ? (res['isError'] || res[:isError]) : nil
  record('throwing tool reported', flag == true || !text_of(res).nil?, "isError=#{flag.inspect}")
rescue StandardError => e
  record('throwing tool reported', true, "rejected #{e.class}")
end

begin
  args = { 'text' => UNICODE, 'number' => -0.5, 'flag' => false,
           'nested' => { 'a' => [1, nil, true], 'b' => { 'c' => SEPARATORS } } }
  got = JSON.parse(text_of(call(client, 'echo', args)) || '{}')
  record('arguments round trip', got == args, JSON.generate(got)[0, 70])
rescue StandardError => e
  record('arguments round trip', false, "#{e.class}: #{e.message}")
end

begin
  started = Time.now
  got = text_of(call(client, 'slow'))
  record('slow call completes', got == 'slow-done', "#{((Time.now - started) * 1000).to_i}ms")
rescue StandardError => e
  record('slow call completes', false, "#{e.class}: #{e.message}")
end

begin
  res = call(client, 'shadowedError')
  record('result with an error field', text_of(res) == 'ok', text_of(res).inspect)
rescue StandardError => e
  record('result with an error field', false, "#{e.class}: #{e.message}")
end

begin
  threads = 5.times.map { Thread.new { text_of(call(client, 'plain')) } }
  got = threads.map(&:value)
  record('5 concurrent calls', got.all? { |t| t == PLAIN }, "#{got.length} replies")
rescue StandardError => e
  record('5 concurrent calls', false, "#{e.class}: #{e.message}")
end

begin
  res = call(client, 'noSuchTool')
  flag = res.is_a?(Hash) ? (res['isError'] || res[:isError]) : nil
  record('unknown tool errors', !!flag, "isError=#{flag.inspect}")
rescue StandardError => e
  record('unknown tool errors', true, "rejected #{e.class}")
end

puts JSON.generate($results)

// Minimal rmcp client, to confirm behaviourally what the source says about
// `DEFAULT_MAX_SSE_EVENT_SIZE`. Reading a constant is not the same as watching
// it apply, and reading has misled me twice today.
use rmcp::{
    ServiceExt,
    model::CallToolRequestParams,
    transport::StreamableHttpClientTransport,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::args().nth(1).expect("usage: battery <url>");
    let tool = std::env::args().nth(2).unwrap_or_else(|| "large".to_string());

    let transport = StreamableHttpClientTransport::from_uri(url);
    let client = ().serve(transport).await?;

    let result = client
        .call_tool(
            CallToolRequestParams::new(tool.clone())
                .with_arguments(serde_json::Map::new()),
        )
        .await;

    match result {
        Ok(res) => {
            let mut len = 0usize;
            let mut sample = String::new();
            for c in res.content.iter() {
                if let Some(t) = c.as_text() {
                    len = t.text.len();
                    sample = t.text.chars().take(24).collect();
                }
            }
            println!("OK tool={} bytes={} sample={:?}", tool, len, sample);
        }
        Err(e) => println!("ERR tool={} {}", tool, e),
    }

    client.cancel().await?;
    Ok(())
}

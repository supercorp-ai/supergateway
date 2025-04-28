FROM nikolaik/python-nodejs:python3.13-nodejs22

# The installer requires curl (and certificates) to download the release archive
RUN apt-get update && \
	apt-get install -y --no-install-recommends curl ca-certificates && \
	apt-get clean && \
	rm -rf /var/lib/apt/lists/*

# Download the latest installer
ADD https://astral.sh/uv/install.sh /uv-installer.sh

# Run the installer then remove it
RUN sh /uv-installer.sh && rm /uv-installer.sh

# Ensure the installed binary is on the `PATH`
ENV PATH="/root/.local/bin/:$PATH"

RUN npm install -g supergateway

EXPOSE 8000

ENTRYPOINT ["supergateway"]

CMD ["--help"]

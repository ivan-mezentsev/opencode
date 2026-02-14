IMAGE ?= opencode-discord:local
CONTAINER ?= opencode-discord-local
ENV_FILE ?= .env
DATA_DIR ?= data
HOST_PORT ?= 8787

.PHONY: docker-build docker-run docker-stop docker-restart docker-logs docker-status

docker-build:
	docker build -t $(IMAGE) -f Dockerfile .

docker-run:
	mkdir -p $(DATA_DIR)
	docker rm -f $(CONTAINER) >/dev/null 2>&1 || true
	docker run -d \
		--name $(CONTAINER) \
		--env-file $(ENV_FILE) \
		-e DATABASE_PATH=/data/discord.sqlite \
		-p $(HOST_PORT):8787 \
		-v $(CURDIR)/$(DATA_DIR):/data \
		$(IMAGE)

docker-stop:
	docker stop $(CONTAINER) >/dev/null 2>&1 || true
	docker rm $(CONTAINER) >/dev/null 2>&1 || true

docker-restart: docker-stop docker-run

docker-logs:
	docker logs -f $(CONTAINER)

docker-status:
	docker ps --filter "name=$(CONTAINER)" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

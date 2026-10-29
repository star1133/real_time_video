from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient

import main


def create_room(client: TestClient) -> tuple[str, str]:
    response = client.post("/rooms", follow_redirects=False)
    assert response.status_code == 303
    location = response.headers["location"]
    parsed = urlsplit(location)
    room_id = parsed.path.rsplit("/", 1)[-1]
    token = parse_qs(parsed.fragment)["host"][0]
    return room_id, token


def test_room_volume_websocket_flow():
    with TestClient(main.app) as client:
        room_id, token = create_room(client)
        headers = {"origin": "http://testserver"}

        with client.websocket_connect(f"/ws/{room_id}", headers=headers) as host:
            host.send_json({"type": "HELLO", "host_token": token, "p2p": False})
            welcome = host.receive_json()
            assert welcome["type"] == "WELCOME"
            assert welcome["role"] == "host"
            assert welcome["state"]["volume"] == 100

            host.send_json({
                "type": "ROOM_VOLUME",
                "command_id": "set-volume-1",
                "volume": 28,
            })
            state = host.receive_json()
            assert state["type"] == "STATE"
            assert state["volume"] == 28
            assert state["volume_revision"] == 1

            with client.websocket_connect(f"/ws/{room_id}", headers=headers) as viewer:
                viewer.send_json({"type": "HELLO", "host_token": None, "p2p": False})
                viewer_welcome = viewer.receive_json()
                assert viewer_welcome["role"] == "viewer"
                assert viewer_welcome["state"]["volume"] == 28

                viewer.send_json({
                    "type": "ROOM_VOLUME",
                    "command_id": "viewer-volume-1",
                    "volume": 5,
                })
                error = viewer.receive_json()
                assert error["type"] == "ERROR"
                assert "Host" in error["message"]

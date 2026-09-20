"""D2 显式执行参数。库存目标、方案确认和跨任务计算属于 Backend。"""
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator

from contract import MAX_COUNT


class Operation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: int = Field(ge=2, le=2)


class Inventory(Operation):
    kind: Literal["scan_inventory"]


class Fight(Operation):
    stage: str = Field(pattern=r"^[A-Z0-9][A-Z0-9-]{0,39}$")
    medicine: int = Field(ge=0, le=0)
    premium: int = Field(ge=0, le=0)
    series: int = Field(ge=1, le=10)


class CountFight(Fight):
    kind: Literal["fight_count"]
    count: int = Field(ge=1, le=MAX_COUNT)


class MaterialFight(Fight):
    kind: Literal["fight_material"]
    item_id: str = Field(pattern=r"^[A-Za-z0-9_]{1,80}$")
    quantity: int = Field(ge=1, le=MAX_COUNT)
    max_count: int | None = Field(default=None, ge=1, le=MAX_COUNT)

    @field_validator("max_count", mode="before")
    @classmethod
    def explicit_limit(cls, value):
        if value is None:
            raise ValueError("omit max_count when no explicit limit is requested")
        return value


ExecutionParams = Annotated[Inventory | CountFight | MaterialFight, Field(discriminator="kind")]


def core_task(params):
    """Only allow the known operation mapping; never forward arbitrary Core parameters."""
    if params["kind"] == "scan_inventory":
        return "Depot", {}
    result = {"stage": params["stage"], "series": params["series"],
              "times": params["count"] if params["kind"] == "fight_count" else params.get("max_count") or MAX_COUNT,
              "medicine": 0, "medicine_expire_days": 0, "stone": 0,
              "client_type": "", "server": "CN", "DrGrandet": False,
              "report_to_penguin": False, "report_to_yituliu": False}
    if params["kind"] == "fight_material":
        result["drops"] = {params["item_id"]: params["quantity"]}
    return "Fight", result
